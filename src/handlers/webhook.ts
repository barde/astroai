import { Context } from 'hono';
import { validateWebhookSignature } from '../utils/crypto';
import { isDuplicateEvent } from '../utils/deduplication';
import { checkRateLimit } from '../utils/rateLimit';
import type { Env } from '../types/env';
import type {
  GitHubWebhookHeaders,
  WebhookPayload,
  PullRequestEvent,
  IssueCommentEvent,
} from '../types/github';
import { processReviewWithRetry } from '../services/review-processor';
import { StorageServiceFactory } from '../storage';

export async function webhookHandler(c: Context<{ Bindings: Env }>) {
  const startTime = Date.now();

  try {
    // Extract headers
    const headers: GitHubWebhookHeaders = {
      'x-hub-signature-256': c.req.header('x-hub-signature-256'),
      'x-github-event': c.req.header('x-github-event'),
      'x-github-delivery': c.req.header('x-github-delivery'),
    };

    console.log('=== WEBHOOK RECEIVED ===', {
      event: headers['x-github-event'],
      delivery: headers['x-github-delivery'],
      hasSignature: !!headers['x-hub-signature-256'],
      timestamp: new Date().toISOString(),
    });

    // Validate webhook signature
    const body = await c.req.text();
    const isValid = await validateWebhookSignature(
      body,
      headers['x-hub-signature-256'] || '',
      c.env.GITHUB_WEBHOOK_SECRET
    );

    if (!isValid) {
      console.error('=== WEBHOOK SIGNATURE FAILED ===', {
        hasSignature: !!headers['x-hub-signature-256'],
        hasSecret: !!c.env.GITHUB_WEBHOOK_SECRET,
        secretLength: c.env.GITHUB_WEBHOOK_SECRET?.length || 0,
        delivery: headers['x-github-delivery'],
      });
      return c.json({ error: 'Invalid signature' }, 401);
    }

    console.log('=== WEBHOOK SIGNATURE VALID ===');

    // Parse payload
    let payload = JSON.parse(body) as WebhookPayload;
    const eventType = headers['x-github-event'];
    const deliveryId = headers['x-github-delivery'] || crypto.randomUUID();

    console.log('=== WEBHOOK PAYLOAD ===', {
      event: eventType,
      action: payload.action,
      pr: 'pull_request' in payload ? payload.pull_request?.number : undefined,
      repo: payload.repository?.full_name,
      draft: 'pull_request' in payload ? payload.pull_request?.draft : undefined,
      installation: payload.installation?.id,
    });

    // Only process pull request events, review requests, and issue comments
    if (
      eventType !== 'pull_request' &&
      eventType !== 'pull_request_review' &&
      eventType !== 'issue_comment'
    ) {
      console.log('=== EVENT IGNORED (not PR, review, or comment) ===', { eventType });
      return c.json({ message: 'Event ignored' }, 200);
    }

    // For pull_request events, only process review_requested action
    if (eventType === 'pull_request') {
      if (payload.action !== 'review_requested') {
        console.log('=== ACTION IGNORED (not review_requested) ===', { action: payload.action });
        return c.json({ message: 'Action ignored - waiting for review request' }, 200);
      }

      // Check if ArgusAI was requested as a reviewer
      const requestedReviewer = (payload as any).requested_reviewer;
      if (
        !requestedReviewer ||
        requestedReviewer.type !== 'Bot' ||
        !requestedReviewer.login?.includes('argus-ai-assistant')
      ) {
        console.log('=== REVIEW REQUEST IGNORED (not for ArgusAI) ===', {
          reviewer: requestedReviewer?.login,
          type: requestedReviewer?.type,
        });
        return c.json({ message: 'Review request not for ArgusAI' }, 200);
      }
    }

    // Parse repository info early for all event types
    const [owner, repo] = payload.repository.full_name.split('/');
    if (!owner || !repo) {
      console.log('=== INVALID REPOSITORY NAME ===', {
        repository: payload.repository.full_name,
      });
      return c.json({ message: 'Invalid repository name' }, 400);
    }

    // Handle @mention in issue comments (PRs are also issues in GitHub)
    if (eventType === 'issue_comment') {
      const commentPayload = payload as IssueCommentEvent;

      // Only process created comments on PRs
      if (commentPayload.action !== 'created' || !commentPayload.issue.pull_request) {
        console.log('=== COMMENT IGNORED (not created or not on PR) ===', {
          action: commentPayload.action,
          isPR: !!commentPayload.issue.pull_request,
        });
        return c.json({ message: 'Comment ignored' }, 200);
      }

      const comment = commentPayload.comment?.body || '';
      const mentionPattern =
        /@argus-ai-assistant\s+(review|skip)(?:\s+(security|performance|style))?/i;
      const match = comment.match(mentionPattern);

      if (!match) {
        console.log('=== COMMENT IGNORED (no ArgusAI mention) ===');
        return c.json({ message: 'No ArgusAI mention found' }, 200);
      }

      const command = match[1]!.toLowerCase();
      const reviewType = match[2]?.toLowerCase() || 'full';
      console.log('=== ARGUSAI MENTION DETECTED ===', {
        command,
        reviewType,
        pr: commentPayload.issue.number,
        commenter: commentPayload.comment.user?.login || 'unknown',
      });

      // For skip command, just acknowledge
      if (command === 'skip') {
        // TODO: Implement skip logic
        return c.json({ message: 'Skip command acknowledged' }, 200);
      }

      // For review command, fetch the full PR data
      const { GitHubAPIService } = await import('../services/github-api');
      const githubApi = new GitHubAPIService(c.env, commentPayload.installation?.id || 0);

      try {
        const pullRequest = await githubApi.getFullPullRequest(
          owner,
          repo,
          commentPayload.issue.number
        );

        // Convert to PullRequestEvent format for processing
        const prPayload: PullRequestEvent = {
          action: 'opened', // Use a valid action
          number: commentPayload.issue.number,
          pull_request: pullRequest as any,
          repository: commentPayload.repository,
          installation: commentPayload.installation,
          organization: commentPayload.organization,
          sender: commentPayload.sender,
        };

        // Store review type in metadata
        (prPayload as any).reviewType = reviewType;
        (prPayload as any).triggeredBy = 'mention';

        // Replace payload with PR event payload
        payload = prPayload;
      } catch (error) {
        console.error('Failed to fetch PR data:', error);
        return c.json({ error: 'Failed to fetch pull request' }, 500);
      }
    }

    // Skip draft PRs
    if ('pull_request' in payload && payload.pull_request?.draft) {
      return c.json({ message: 'Draft PR ignored' }, 200);
    }

    // Initialize storage service
    const storageFactory = new StorageServiceFactory();
    const storage = storageFactory.create(c.env);

    // Check if repository is on the allowed list
    const { AllowedReposService } = await import('../storage/allowed-repos');
    const allowedRepos = new AllowedReposService(c.env.CONFIG);
    const isAllowed = await allowedRepos.isAllowed(owner, repo);

    if (!isAllowed) {
      console.log('=== REPOSITORY NOT ALLOWED ===', {
        repository: payload.repository.full_name,
        action: payload.action,
      });
      return c.json({ message: 'Repository not on allowed list' }, 200);
    }

    // At this point, payload should be a PullRequestEvent
    const prPayload = payload as PullRequestEvent;

    // Check for duplicate events
    const isDupe = await isDuplicateEvent(
      storage,
      prPayload.repository.full_name,
      prPayload.pull_request.number,
      deliveryId
    );

    if (isDupe) {
      return c.json({ message: 'Duplicate event' }, 200);
    }

    // Check rate limits
    const rateLimitOk = await checkRateLimit(storage, payload.installation?.id || 0);

    if (!rateLimitOk) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Save webhook info for debugging
    const { saveDebugWebhook } = await import('./debug');
    await saveDebugWebhook(c.env, prPayload);

    // Process the review asynchronously using event.waitUntil
    // This allows us to return a response immediately while processing continues
    // Return response immediately for fast webhook processing
    // The actual review processing happens asynchronously with retry logic
    c.executionCtx.waitUntil(
      processReviewWithRetry(c.env, prPayload, deliveryId).catch(async (error) => {
        console.error('=== ASYNC PROCESSING ERROR ===', error);
        const { saveDebugError } = await import('./debug');
        await saveDebugError(c.env, error, {
          event: 'webhook_async_error',
          payload: {
            action: prPayload.action,
            pr: prPayload.pull_request?.number,
            repo: prPayload.repository?.full_name,
          },
        });
      })
    );

    // Log webhook response time (should be <50ms)
    const processingTime = Date.now() - startTime;
    console.log(`Webhook responded in ${processingTime}ms`, {
      repository: prPayload.repository.full_name,
      pr: prPayload.pull_request.number,
      action: prPayload.action,
      deliveryId,
    });

    return c.json(
      {
        message: 'Review processing started',
        deliveryId,
        processingTime,
      },
      200
    );
  } catch (error) {
    console.error('Webhook handler error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
