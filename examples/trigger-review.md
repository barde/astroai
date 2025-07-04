# ArgusAI Review Examples

This document shows various ways to trigger ArgusAI code reviews.

## Method 1: Reviewer Assignment (Requires Bot as Collaborator)

1. **Add ArgusAI as Collaborator** (one-time setup)
   ```
   Settings → Manage access → Add people → Search "argus-ai-assistant[bot]" → Add with Write permission
   ```

2. **Request Review**
   - Open any Pull Request
   - Click "Reviewers" in the right sidebar
   - Select `argus-ai-assistant[bot]`
   - ArgusAI will review within ~30 seconds

## Method 2: @Mention Commands

Post a comment on any open PR with one of these commands:

### Basic Review
```
@argus-ai-assistant review
```
*Triggers a comprehensive code review*

### Focused Reviews
```
@argus-ai-assistant review security
```
*Focuses on security vulnerabilities*

```
@argus-ai-assistant review performance
```
*Focuses on performance issues*

```
@argus-ai-assistant review style
```
*Focuses on code style and best practices*

### Skip Review
```
@argus-ai-assistant skip
```
*Prevents ArgusAI from reviewing this PR (useful if automatic reviews are enabled)*

## Example PR Comment

```markdown
Hey team, I've made the requested changes to the authentication system.

@argus-ai-assistant review security

Can someone also do a manual review focusing on the business logic?
```

## API Examples

### Using GitHub CLI

```bash
# Request review from ArgusAI
gh pr view 123 --json url -q .url | xargs -I {} gh api -X POST \
  repos/OWNER/REPO/pulls/123/requested_reviewers \
  --field 'reviewers[]=argus-ai-assistant[bot]'
```

### Using cURL

```bash
# Trigger review via comment
curl -X POST \
  -H "Authorization: token YOUR_GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/OWNER/REPO/issues/PR_NUMBER/comments \
  -d '{"body":"@argus-ai-assistant review"}'
```

### Using GitHub Actions

```yaml
name: Auto Request ArgusAI Review
on:
  pull_request:
    types: [opened, reopened]

jobs:
  request-review:
    runs-on: ubuntu-latest
    steps:
      - name: Request ArgusAI Review
        run: |
          gh api -X POST \
            repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/requested_reviewers \
            --field 'reviewers[]=argus-ai-assistant[bot]'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Troubleshooting

### ArgusAI Not Responding?

1. **Check Repository is Allowed**
   ```bash
   curl https://argus.vogel.yoga/allowed-repos/owner/repo
   ```

2. **Check ArgusAI Status**
   ```bash
   curl https://argus.vogel.yoga/health
   ```

3. **Check Webhook Delivery**
   - Go to Settings → Webhooks
   - Find the ArgusAI webhook
   - Check "Recent Deliveries" tab

### Common Issues

- **"argus-ai-assistant[bot] not found"** - Bot needs to be added as collaborator first
- **No response to @mention** - Ensure exact syntax `@argus-ai-assistant review`
- **Repository not allowed** - Contact admin to add to allowlist