# Deployment Checklist

Use this checklist to ensure everything is properly configured before deployment.

## Pre-Deployment Checklist

### Environment & Security
- [ ] All `.env.local` variables are set and verified
- [ ] `JWT_SECRET` is cryptographically secure (32+ characters)
- [ ] `MYASP_WEBHOOK_SECRET` is unique and strong
- [ ] No secrets are committed to git (check `.gitignore`)
- [ ] `NEXT_PUBLIC_SITE_NAME` is set correctly in `.env.local`

### Database
- [ ] Supabase project created and accessible
- [ ] `supabase-schema.sql` has been executed successfully
- [ ] All 4 tables exist: `subscribers`, `otp_codes`, `chat_threads`, `chat_messages`
- [ ] Indexes are created on all relevant columns
- [ ] Row Level Security (RLS) is enabled on all tables
- [ ] Service role policies are in place

### Google Gemini
- [ ] API key created and valid at https://aistudio.google.com/apikey
- [ ] Billing is enabled on Google Cloud project
- [ ] `GEMINI_API_KEY` is set in `.env.local`

### Email (Resend)
- [ ] Resend account created at https://resend.com
- [ ] API key generated
- [ ] `RESEND_API_KEY` is set in `.env.local`
- [ ] Sender domain is configured (or using default `resend.dev`)
- [ ] Email template in `src/app/api/auth/send-otp/route.ts` uses correct sender email

### Google Docs
- [ ] All 41 Google Doc IDs are added to `src/lib/transcript-config.ts`
- [ ] All docs have link sharing enabled (public access)
- [ ] All docs are accessible via their export URLs
- [ ] `src/lib/transcript-config.ts` is fully populated with all document IDs and titles

### Code Quality
- [ ] TypeScript compiles without errors: `npm run build`
- [ ] No console warnings or errors in development mode
- [ ] All API routes respond correctly in local testing
- [ ] Chat streaming works properly locally
- [ ] OTP flow works end-to-end locally
- [ ] Authentication middleware is protecting `/chat` routes

### Testing
- [ ] Test OTP email sending (check Resend logs)
- [ ] Test OTP verification with correct/incorrect codes
- [ ] Test chat message sending and receiving
- [ ] Test thread creation and switching
- [ ] Test logout functionality
- [ ] Test MyASP webhook with test payload
- [ ] Test all edge cases (empty inputs, very long messages, special characters)

## Deployment to Vercel

### Before Deploying

1. Ensure all tests pass locally:
```bash
npm run build
npm run dev  # Manual testing
```

2. Double-check all environment variables in `.env.local` match expected values

3. Commit all changes to git (except `.env.local`):
```bash
git add .
git commit -m "Initial project setup"
git push
```

### Deployment Steps

#### Option 1: GitHub Integration (Recommended)

1. Push code to GitHub
2. Go to https://vercel.com/new
3. Import your GitHub repository
4. Select the project
5. In "Environment Variables" section, add all variables from `.env.local`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY`
   - `RESEND_API_KEY`
   - `JWT_SECRET`
   - `MYASP_WEBHOOK_SECRET`
   - `NEXT_PUBLIC_SITE_NAME`
6. Click "Deploy"
7. Wait for build to complete

#### Option 2: Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy (first time)
vercel

# Subsequent deployments
vercel --prod
```

### Post-Deployment

1. [ ] Verify deployment completed successfully
2. [ ] Visit https://your-domain.com and check homepage redirects correctly
3. [ ] Test login page loads: https://your-domain.com/login
4. [ ] Test OTP sending (check inbox, may take a few seconds)
5. [ ] Test OTP verification and login flow
6. [ ] Test chat functionality with a message
7. [ ] Check Vercel logs for any errors: https://vercel.com/dashboard
8. [ ] Check database in Supabase for new records (subscribers, chat_threads, chat_messages)

## Production Configuration

### Vercel Dashboard Settings

1. **Project Settings**
   - Build Command: `next build` (should be auto-detected)
   - Output Directory: `.next` (should be auto-detected)
   - Install Command: `npm ci` (should be auto-detected)

2. **Environment Variables**
   - Add all variables from `.env.local`
   - Mark sensitive variables as "Sensitive" if available

3. **Domains**
   - Add your custom domain
   - Configure DNS records as shown by Vercel

4. **Analytics**
   - Enable Vercel Web Analytics (optional)
   - Enable Edge Middleware Analytics (optional)

### Supabase Production Config

1. **Database Backups**
   - Enable automatic daily backups
   - Set backup retention to at least 7 days

2. **Security**
   - Review RLS policies on all tables
   - Only service role should have full access
   - Anon key should have no access to sensitive tables

3. **Monitoring**
   - Set up alerts for high connection count
   - Monitor query performance
   - Review database logs regularly

### MyASP Webhook Configuration

1. [ ] Set webhook URL in MyASP: `https://your-domain.com/api/webhook/myasp`
2. [ ] Add authentication header: `x-webhook-token: your-secret`
3. [ ] Test webhook with payment event
4. [ ] Verify subscriber is created/updated in Supabase
5. [ ] Test webhook with cancellation event
6. [ ] Verify status is updated to 'cancelled'

### Email Configuration (Resend)

1. [ ] If using custom domain:
   - Configure DNS records
   - Verify domain in Resend
   - Update sender email in send-otp route
2. [ ] Test email delivery to production inbox
3. [ ] Check email appears correctly (formatting, links, etc.)
4. [ ] Monitor email bounce rates in Resend dashboard

## Monitoring & Maintenance

### Daily
- [ ] Check error logs in Vercel
- [ ] Monitor Supabase connection health
- [ ] Spot-check user sessions are working

### Weekly
- [ ] Review failed OTP attempts
- [ ] Check average response times for chat
- [ ] Review Resend bounce/complaint metrics

### Monthly
- [ ] Update dependencies: `npm update`
- [ ] Review Supabase database size
- [ ] Check API rate limits
- [ ] Review cost usage
- [ ] Backup Supabase manually

## Rollback Plan

If something goes wrong after deployment:

1. **Revert Code**
   ```bash
   git revert <commit-hash>
   git push
   # Vercel will auto-redeploy
   ```

2. **Revert Environment Variables**
   - Go to Vercel Dashboard > Project > Settings > Environment Variables
   - Restore previous values

3. **Emergency Disable**
   - In Vercel Dashboard, click "Pause" or "Redeploy" previous version

4. **Database Recovery**
   - If data is corrupted, restore from Supabase backup
   - Go to Supabase Dashboard > Backups
   - Restore to a point before the issue

## Performance Optimization

### Caching
- [ ] Verify transcript cache is working (24-hour TTL)
- [ ] Monitor cache hit rate in logs

### Database
- [ ] Enable connection pooling in Supabase
- [ ] Monitor slow queries
- [ ] Optimize OTP cleanup job (optional)

### Frontend
- [ ] Verify Next.js image optimization is working
- [ ] Check bundle size: `npm run build -- --analyze`
- [ ] Monitor Core Web Vitals in Vercel Analytics

## Security Hardening (Post-Launch)

1. [ ] Enable 2FA on all admin accounts
2. [ ] Set up rate limiting on API endpoints
3. [ ] Add CSRF protection if needed
4. [ ] Enable CORS properly (restrict to your domain)
5. [ ] Review security headers in `next.config.ts`
6. [ ] Set up DDoS protection (Vercel provides some by default)
7. [ ] Monitor for unauthorized API access
8. [ ] Rotate JWT_SECRET and MYASP_WEBHOOK_SECRET every 90 days

## Success Criteria

Before considering deployment complete:

- ✅ Application loads without errors
- ✅ Login flow works end-to-end
- ✅ OTP emails deliver successfully
- ✅ Chat responses stream in real-time
- ✅ Messages persist in database
- ✅ Multiple threads can be created and switched
- ✅ MyASP webhook integration works
- ✅ No console errors in browser or server
- ✅ All environment variables are set correctly
- ✅ Database backups are configured
- ✅ Error monitoring is set up

## Support Contacts

- **Vercel**: https://vercel.com/support
- **Supabase**: https://supabase.com/docs
- **Google Cloud**: https://cloud.google.com/support
- **Resend**: https://resend.com/support
