# Quick Setup Guide

Follow these steps to get the project running locally and deployed to production.

## Step 1: Clone and Install

```bash
cd yutakasa-tapping-coach
npm install
```

## Step 2: Set Up Supabase

1. Create a new Supabase project at https://supabase.com
2. Go to SQL Editor
3. Create a new query and paste the contents of `supabase-schema.sql`
4. Run the SQL to create all tables and indexes
5. Copy your project credentials:
   - Go to Settings > API
   - Copy `Project URL` → `SUPABASE_URL`
   - Copy `anon public` → `SUPABASE_ANON_KEY`
   - Copy `service_role` → `SUPABASE_SERVICE_ROLE_KEY`

## Step 3: Set Up Google Gemini API

1. Go to https://aistudio.google.com/apikey
2. Create a new API key
3. Copy it → `GEMINI_API_KEY`

## Step 4: Set Up Resend Email

1. Create account at https://resend.com
2. Create API key
3. Copy it → `RESEND_API_KEY`
4. Note your sender email (defaults to `noreply@resend.dev` for testing)

## Step 5: Generate JWT Secret

```bash
# Generate a secure 32+ character JWT secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output → `JWT_SECRET`

## Step 6: Create `.env.local`

```bash
cp .env.local.example .env.local
```

Fill in all values from steps 2-5 in `.env.local`

## Step 7: Add MyASP Webhook Secret

Generate another secure secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy it → `MYASP_WEBHOOK_SECRET`

## Step 8: Add Google Doc IDs

1. Get all 41 Google Doc IDs from your content manager
2. Update `src/lib/transcript-config.ts` with all doc IDs and titles
3. Ensure all Google Docs have link sharing enabled (public access)

## Step 9: Run Locally

```bash
npm run dev
```

Visit http://localhost:3000

**Test Flow:**
1. Add a test user to Supabase `subscribers` table:
   ```sql
   INSERT INTO subscribers (email, name, status)
   VALUES ('test@example.com', 'Test User', 'active');
   ```
2. Go to http://localhost:3000/login
3. Enter test@example.com
4. Check Resend logs or console for OTP code (or check Supabase `otp_codes` table)
5. Enter the code to login

## Step 10: Deploy to Vercel

```bash
# Login to Vercel
vercel login

# Deploy
vercel --prod
```

Or connect GitHub repo to Vercel dashboard and it will auto-deploy on push.

## Step 11: Configure MyASP Webhook

In MyASP admin panel:
1. Set webhook URL: `https://your-domain.com/api/webhook/myasp`
2. Add header:
   - Header: `x-webhook-token`
   - Value: (your MYASP_WEBHOOK_SECRET)
3. Subscribe to events:
   - Payment completed
   - Subscription cancelled

## Environment Variables Reference

| Variable | Source | Example |
|----------|--------|---------|
| `SUPABASE_URL` | Supabase Settings > API | `https://abc.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase Settings > API | `eyJ0eXAi...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Settings > API | `eyJ0eXAi...` |
| `GEMINI_API_KEY` | Google AI Studio | `AIzaSy...` |
| `RESEND_API_KEY` | Resend Dashboard > API Keys | `re_abc123...` |
| `JWT_SECRET` | Generate with `node -e ...` | `a1b2c3d4...` (32+ chars) |
| `MYASP_WEBHOOK_SECRET` | Generate with `node -e ...` | `e5f6g7h8...` (32+ chars) |
| `NEXT_PUBLIC_SITE_NAME` | (optional) | `豊かさタッピング AIコーチ` |

## Verify Installation

After setup, verify everything works:

```bash
# Check environment variables are loaded
npm run dev

# Test login flow
# Test chat functionality
# Check Supabase data is being saved
```

## Common Issues

### "Email not registered"
- Add the email to `subscribers` table in Supabase with status='active'

### OTP not sending
- Check Resend API key is correct
- Check email domain is configured in Resend
- For development, check console or Supabase `otp_codes` table for generated code

### Chat not responding
- Check GEMINI_API_KEY is valid
- Verify Google Docs are publicly accessible
- Check browser console for errors

### Database errors
- Verify SUPABASE_SERVICE_ROLE_KEY is correct (not anon key)
- Check Supabase table permissions

## Next Steps

1. **Customize branding**: Edit `NEXT_PUBLIC_SITE_NAME` in .env.local
2. **Add all Google Docs**: Update `src/lib/transcript-config.ts` with all 41 docs
3. **Configure email template**: Customize OTP email in `src/app/api/auth/send-otp/route.ts`
4. **Set up monitoring**: Add error tracking (Sentry, LogRocket, etc.)
5. **Configure analytics**: Add analytics (Vercel Analytics, Mixpanel, etc.)

## Support

- Documentation: See `README.md`
- Troubleshooting: See `README.md` Troubleshooting section
- API Documentation: See `README.md` API Routes section
