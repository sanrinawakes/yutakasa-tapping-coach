# 豊かさタッピング AIコーチ - Member Site

A Next.js 14+ application that provides an AI-powered coaching chatbot for the "豊かさタッピング" program. Users authenticate via email OTP and chat with an AI coach trained on 41 Google Docs containing course content.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4
- **Database**: Supabase (PostgreSQL)
- **AI**: Google Generative AI (Gemini Pro)
- **Email**: Resend
- **Auth**: JWT (jose)
- **Deployment**: Vercel

## Features

### Authentication
- Email-based OTP login (6-digit code)
- No account creation required - verify against MyASP subscriber list
- JWT session management (7-day expiry)
- Middleware-protected routes

### AI Chatbot
- Gemini 1.5 Flash for intelligent responses
- 41 Google Doc transcripts loaded into system prompt
- Markdown rendering with code highlighting
- Streaming responses for real-time feedback
- Conversation memory per chat thread

### Chat Management
- Multiple chat threads per user
- Thread creation, switching, and deletion
- Message history persistence
- Auto-save of all interactions

### MyASP Integration
- Webhook endpoint for payment/cancellation events
- Auto-sync of active subscribers
- Status tracking (active/cancelled)

## Setup

### 1. Prerequisites

- Node.js 18+
- npm/yarn/pnpm
- Supabase account
- Google Cloud API key (Gemini)
- Resend API key

### 2. Environment Variables

Copy `.env.local.example` to `.env.local` and fill in all values:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
GEMINI_API_KEY=your-gemini-api-key
RESEND_API_KEY=your-resend-api-key
JWT_SECRET=your-jwt-secret-min-32-chars
MYASP_WEBHOOK_SECRET=your-webhook-secret
NEXT_PUBLIC_SITE_NAME=豊かさタッピング AIコーチ
```

**Important**: Generate a strong `JWT_SECRET` (at least 32 characters):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Database Setup

1. Create a new Supabase project
2. Go to SQL Editor and run the SQL from `supabase-schema.sql`:
   - Creates tables: subscribers, otp_codes, chat_threads, chat_messages
   - Sets up indexes for performance
   - Configures Row Level Security policies

### 4. Install Dependencies

```bash
npm install
```

### 5. Google Docs Setup

The project fetches course content from 41 Google Docs. Update the doc IDs in `src/lib/transcript-config.ts`:

```typescript
export const GOOGLE_DOC_TRANSCRIPTS = [
  {
    id: "YOUR_DOC_ID",
    title: "Section Title",
  },
  // ... more docs
];
```

Each Google Doc must be:
- Publicly accessible (link sharing enabled)
- Readable by anyone with the link

### 6. Email Setup (Resend)

1. Sign up at [resend.com](https://resend.com)
2. Create an API key
3. Add your domain (or use the default resend.dev domain for testing)
4. Update the `from` email in `src/app/api/auth/send-otp/route.ts`

### 7. MyASP Webhook Configuration

1. In MyASP admin, set webhook endpoint to:
   ```
   https://your-domain.com/api/webhook/myasp
   ```
2. Add custom header for security:
   ```
   x-webhook-token: your-myasp-webhook-secret
   ```
3. Subscribe to events:
   - Payment completed
   - Subscription cancelled

## Running Locally

```bash
npm run dev
```

Visit `http://localhost:3000`

- Login page: `http://localhost:3000/login`
- Chat page: `http://localhost:3000/chat` (requires auth)

## File Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout
│   ├── page.tsx                # Redirect logic
│   ├── globals.css             # Tailwind + custom styles
│   ├── login/
│   │   └── page.tsx            # Login form (email + OTP)
│   ├── chat/
│   │   ├── layout.tsx          # Chat layout wrapper
│   │   └── page.tsx            # Main chat interface
│   └── api/
│       ├── auth/
│       │   ├── send-otp/       # Generate & send OTP
│       │   ├── verify-otp/     # Verify code & create session
│       │   └── logout/         # Clear session
│       ├── chat/               # Stream Gemini responses
│       ├── threads/            # CRUD operations
│       ├── messages/           # Fetch message history
│       ├── webhook/
│       │   └── myasp/          # MyASP payment webhook
│       └── admin/
│           └── refresh-content/ # Clear cache
├── components/
│   ├── ChatSidebar.tsx         # Thread list + controls
│   ├── ChatMessages.tsx        # Message display
│   └── ChatInput.tsx           # Input form
├── lib/
│   ├── supabase.ts            # Database functions
│   ├── auth.ts                # JWT helpers
│   ├── gemini.ts              # AI client + prompt
│   ├── transcript-config.ts   # Google Doc IDs
│   └── constants.ts           # App constants
└── middleware.ts              # Protected route auth

Configuration Files:
├── tsconfig.json              # TypeScript config
├── next.config.ts             # Next.js config
├── tailwind.config.ts         # Tailwind config
├── postcss.config.mjs         # PostCSS config
├── .env.local.example         # Environment template
└── supabase-schema.sql        # Database schema
```

## API Routes

### Authentication
- `POST /api/auth/send-otp` - Send OTP email
- `POST /api/auth/verify-otp` - Verify code & create session
- `POST /api/auth/logout` - Clear session

### Chat
- `POST /api/chat` - Send message & get streamed response

### Threads
- `GET /api/threads` - List user's threads
- `POST /api/threads` - Create new thread
- `PATCH /api/threads` - Update thread title
- `GET /api/threads/[id]` - Get thread with messages
- `DELETE /api/threads/[id]` - Delete thread

### Messages
- `GET /api/messages/[threadId]` - Get messages for thread

### Webhooks
- `POST /api/webhook/myasp` - MyASP payment events

### Admin
- `POST /api/admin/refresh-content` - Clear transcript cache (requires admin token)

## Deployment

### Vercel (Recommended)

1. Push code to GitHub
2. Import project in [Vercel](https://vercel.com)
3. Add environment variables in project settings
4. Deploy

```bash
vercel
```

### Other Platforms

The app can be deployed to any Node.js hosting:
- Railway
- Render
- AWS EC2
- DigitalOcean
- Heroku

```bash
npm run build
npm run start
```

## Security Considerations

1. **JWT Secret**: Use a cryptographically secure random string (32+ chars)
2. **HTTPS Only**: Always use HTTPS in production
3. **Cookie Security**: Cookies are `httpOnly` and `secure` by default
4. **Rate Limiting**: Consider adding rate limiting for OTP and chat endpoints
5. **CORS**: Configure CORS if API is accessed from external domains
6. **Webhook Verification**: MyASP webhook secret should be strong and unpredictable
7. **RLS Policies**: Supabase RLS is configured for service role only (server-side)

## Google Docs Content Fetching

The system:
1. Fetches all 41 Google Docs on first chat request
2. Caches content in memory for 24 hours
3. Includes full content in Gemini system prompt
4. Can be manually refreshed via admin endpoint

To refresh cache without restarting:

```bash
curl -X POST http://localhost:3000/api/admin/refresh-content \
  -H "x-admin-token: your-jwt-secret"
```

## Gemini Model Configuration

- **Model**: `gemini-1.5-flash` (fast, cost-effective)
- **Temperature**: 0.7 (balanced creativity)
- **Max Tokens**: 1024 per response
- **Safety Settings**: Configured to block harmful content

To use a different model, update `GEMINI_MODEL` in `src/lib/constants.ts`.

## Troubleshooting

### OTP Not Sending
- Check Resend API key is valid
- Verify email domain is configured in Resend
- Check spam folder
- Review Resend logs for errors

### Chat Not Responding
- Verify `GEMINI_API_KEY` is valid
- Check Google Docs are publicly accessible
- Ensure Supabase connection is working
- Review browser console for errors

### Database Connection Issues
- Verify Supabase credentials
- Check firewall allows connection
- Ensure service role key has proper permissions
- Review Supabase logs

### Authentication Failing
- Clear browser cookies
- Verify JWT_SECRET is set correctly
- Check session cookie is being saved
- Review middleware logs

## Performance Optimization

- **Streaming**: Responses stream in real-time via ReadableStream
- **Caching**: Transcripts cached for 24 hours in memory
- **Database**: Indexes on frequently queried columns
- **Images**: Use Next.js Image component for optimization
- **Code Splitting**: Next.js automatically code-splits pages

## Future Enhancements

- Admin dashboard for content management
- User analytics and engagement tracking
- Audio-based tapping exercise guidance
- Integration with calendar for scheduled coaching
- Offline mode with service workers
- Multi-language support
- Advanced user search and filtering
- Billing and subscription management

## Support

For issues or questions:
1. Check the Troubleshooting section
2. Review logs in Supabase dashboard
3. Check Vercel deployment logs
4. Review browser console for client-side errors

## License

All rights reserved. This project is proprietary.

## Changelog

### v1.0.0 (Initial Release)
- Email OTP authentication
- Gemini-powered AI chatbot
- Multi-thread chat management
- MyASP webhook integration
- Responsive UI with Tailwind CSS
- Full TypeScript support
