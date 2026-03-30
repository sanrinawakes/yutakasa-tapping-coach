# Quick Reference Guide

## Starting Development

```bash
# Install dependencies
npm install

# Create .env.local with all required variables
cp .env.local.example .env.local
# Edit .env.local with your credentials

# Run development server
npm run dev

# Visit http://localhost:3000
```

## Key Commands

```bash
# Development
npm run dev              # Start dev server on port 3000

# Production
npm run build            # Build for production
npm run start            # Start production server
npm run lint             # Run TypeScript type checking

# Deployment
vercel                   # Deploy to staging (Vercel)
vercel --prod            # Deploy to production (Vercel)
```

## Testing Locally

### Add Test User
1. Go to Supabase Dashboard
2. Click "subscribers" table
3. Insert a new row:
   ```
   email: test@example.com
   name: Test User
   status: active
   ```

### Login Flow
1. Visit http://localhost:3000/login
2. Enter: `test@example.com`
3. Check Supabase `otp_codes` table for the generated code
4. Enter the code to login

### Send Test Webhook
```bash
curl -X POST http://localhost:3000/api/webhook/myasp \
  -H "x-webhook-token: your-jwt-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "data[User][mail]=new@example.com&data[User][name1]=New+User&Type=payment"
```

## File Locations

| What | Where |
|------|-------|
| Login Page | `src/app/login/page.tsx` |
| Chat Page | `src/app/chat/page.tsx` |
| Chat Components | `src/components/Chat*.tsx` |
| API Routes | `src/app/api/` |
| Database Functions | `src/lib/supabase.ts` |
| Auth Helpers | `src/lib/auth.ts` |
| Gemini Integration | `src/lib/gemini.ts` |
| Google Docs Config | `src/lib/transcript-config.ts` |
| Styles | `src/app/globals.css` |
| Database Schema | `supabase-schema.sql` |

## Environment Variables Needed

| Variable | Type | Required |
|----------|------|----------|
| `SUPABASE_URL` | string | Yes |
| `SUPABASE_ANON_KEY` | string | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | string | Yes |
| `GEMINI_API_KEY` | string | Yes |
| `RESEND_API_KEY` | string | Yes |
| `JWT_SECRET` | string (32+ chars) | Yes |
| `MYASP_WEBHOOK_SECRET` | string (32+ chars) | Yes |
| `NEXT_PUBLIC_SITE_NAME` | string | No |

## Common Tasks

### Update Google Doc IDs
Edit `src/lib/transcript-config.ts`:
```typescript
export const GOOGLE_DOC_TRANSCRIPTS = [
  {
    id: "DOCUMENT_ID_HERE",
    title: "Document Title",
  },
  // Add all 41 documents
];
```

### Clear Transcript Cache
```bash
curl -X POST http://localhost:3000/api/admin/refresh-content \
  -H "x-admin-token: your-jwt-secret"
```

### Update OTP Email Template
Edit `src/app/api/auth/send-otp/route.ts`, modify the HTML in the `resend.emails.send()` call.

### Change Session Expiry
In `src/lib/constants.ts`, update:
```typescript
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // Change 7 to desired days
```

### Change Gemini Model
In `src/lib/constants.ts`, update:
```typescript
export const GEMINI_MODEL = "gemini-1.5-pro"; // or another model
```

### Add Custom Styling
Edit `src/app/globals.css` or add component-specific CSS.

## Database Operations

### View All Subscribers
Supabase Dashboard → subscribers table

### Check OTP Codes
Supabase Dashboard → otp_codes table

### View Chat Threads
Supabase Dashboard → chat_threads table (filtered by user_email)

### View Chat Messages
Supabase Dashboard → chat_messages table (filtered by thread_id)

### Delete Old OTP Codes
```sql
DELETE FROM otp_codes WHERE expires_at < NOW();
```

### Get User's Chat History
```sql
SELECT cm.* FROM chat_messages cm
JOIN chat_threads ct ON cm.thread_id = ct.id
WHERE ct.user_email = 'user@example.com'
ORDER BY cm.created_at DESC;
```

## API Reference

### Send OTP
```bash
POST /api/auth/send-otp
Content-Type: application/json

{ "email": "user@example.com" }

Response: { "success": true }
```

### Verify OTP
```bash
POST /api/auth/verify-otp
Content-Type: application/json

{ "email": "user@example.com", "code": "123456" }

Response: { "success": true, "email": "user@example.com" }
```

### Send Message
```bash
POST /api/chat
Content-Type: application/json

{ "threadId": "uuid", "message": "Hello" }

Response: text/event-stream (streaming response)
```

### Get Threads
```bash
GET /api/threads

Response: { "threads": [...] }
```

### Create Thread
```bash
POST /api/threads
Content-Type: application/json

{ "title": "New Chat" }

Response: { "thread": {...} }
```

### Get Messages
```bash
GET /api/messages/[threadId]

Response: { "messages": [...] }
```

## Debugging

### Check Server Logs
```bash
# Terminal where npm run dev is running
# Look for errors, warnings, API calls
```

### Check Browser Console
- Open DevTools (F12)
- Click Console tab
- Look for errors or API responses

### Check Supabase Logs
1. Go to Supabase Dashboard
2. Click Logs on left sidebar
3. Filter by time to see recent activity

### Check Vercel Logs (Production)
1. Go to Vercel Dashboard
2. Select project
3. Click Deployments
4. Click on latest deployment
5. Scroll to view logs

### Common Issues

**OTP not sending:**
- Check RESEND_API_KEY is valid
- Check email domain is configured in Resend
- Check spam folder

**Chat not working:**
- Verify GEMINI_API_KEY is valid
- Ensure Google Docs are publicly accessible
- Check browser console for errors
- Check server logs for API errors

**Login fails:**
- Verify user exists in subscribers table
- Check status is 'active'
- Verify JWT_SECRET is set correctly
- Clear browser cookies and try again

**Database connection fails:**
- Verify all Supabase credentials
- Check firewall allows connections
- Check Supabase project is active
- Review Supabase logs

## Performance Tips

- Transcripts are cached for 24 hours
- Messages stream for real-time feedback
- Database queries use indexes for speed
- Next.js auto-optimizes images and code-splits

## Security Reminders

- Never commit `.env.local` (use `.env.local.example`)
- Rotate JWT_SECRET and MYASP_WEBHOOK_SECRET every 90 days
- Use HTTPS in production
- Keep dependencies updated: `npm update`
- Use strong, unique passwords for Supabase/Vercel

## Additional Resources

- [Next.js Docs](https://nextjs.org/docs)
- [Supabase Docs](https://supabase.com/docs)
- [Tailwind CSS Docs](https://tailwindcss.com/docs)
- [Google Gemini API Docs](https://ai.google.dev/docs)
- [Resend Docs](https://resend.com/docs)
- [jose (JWT) Docs](https://github.com/panva/jose)

## Useful Regex & Patterns

Generate secure random secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Architecture Overview

```
User Request
    ↓
[Next.js Middleware] - JWT verification
    ↓
[Page/API Route]
    ↓
[Library Functions] - auth, supabase, gemini
    ↓
[External Services] - Supabase, Gemini, Resend
    ↓
Response
```

## Development Workflow

1. Make changes to source files
2. Next.js hot-reloads automatically
3. Test in browser (http://localhost:3000)
4. Check console for errors
5. Check Supabase for data changes
6. Commit when satisfied
7. Push to GitHub to trigger Vercel deployment

## Version Info

- Node.js: 18+
- Next.js: 14+
- React: 19+
- TypeScript: 6+
- Tailwind CSS: 4+
