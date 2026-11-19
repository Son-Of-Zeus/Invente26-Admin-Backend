// index.js
require('dotenv').config();

// The participant schema stores timestamp-without-timezone values as IST.
// Set Node's timezone before loading routes so node-postgres parses them as IST.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const cron = require('node-cron');

const { router: staffAuthRouter } = require('./routes/staff-auth');
const otpRouter = require('./routes/otp');
const { syncEvents } = require('./jobs/syncEvents');

// finally refactored the huge index.js into separate route files :)
const scanRouter = require('./routes/scan');
const passesRouter = require('./routes/passes');
const eventsRouter = require('./routes/events');
const analyticsRouter = require('./routes/analytics');
const techRegistrationRouter = require('./routes/tech-registration');
const workshopRegistrationRouter = require('./routes/workshop-registration');
const nonTechRegistrationRouter = require('./routes/non-tech-registration');
const adminRouter = require('./routes/admin');
const receiptUploadRouter = require('./routes/receipt-upload');
const receiptReviewRouter = require('./routes/receipt-review');

const app = express();
app.use(bodyParser.json());
app.use(cors()); // allow all origins in dev; restrict in prod if needed

const PORT = process.env.PORT || 4000;

// health (kept at root)
app.get('/health', (req, res) => res.json({ ok: true }));

// sync status endpoint
app.get('/sync-status', (req, res) => {
  const { syncEvents } = require('./jobs/syncEvents');
  // This will be populated by the syncEvents function
  res.json({ 
    ok: true, 
    message: 'Sync status endpoint - check logs for detailed sync information' 
  });
});

// Group all app routes under a single base to avoid Nginx path conflicts
const baseRouter = express.Router();

// auth
baseRouter.use('/auth', staffAuthRouter);
baseRouter.use('/auth', otpRouter);

// mount routers
baseRouter.use('/', scanRouter);           // scan routes e.g. GET /scan/:passId
baseRouter.use('/passes', passesRouter);   // passes and slot management
baseRouter.use('/events', eventsRouter);   // events listing
baseRouter.use('/analytics', analyticsRouter); // analytics
baseRouter.use('/tech-registration', techRegistrationRouter); // tech registration endpoint
baseRouter.use('/workshop-registration', workshopRegistrationRouter); // workshop registration endpoint
baseRouter.use('/non-tech-registration', nonTechRegistrationRouter); // non-tech registration endpoint
baseRouter.use('/admin', adminRouter); // superadmin-only admin utilities
baseRouter.use('/public/registrations', receiptUploadRouter); // participant PDF upload tickets and Azure HEAD validation
baseRouter.use('/receipt-review', receiptReviewRouter); // volunteer receipt queue and decisions

// Mount base router
app.use('/organizers/api', baseRouter);

// Initialize and start the server
async function startServer() {
  try {
    // This service consumes the participant repository's schema. It must not
    // create or alter tables at startup.
    app.listen(PORT, () => {
      console.log(`Invente25 admin backend listening on ${PORT}`);
      
      // Set up events sync cron job
      // Attendance/event-sync code remains mounted for the later phase, but
      // is opt-in while this service is using the participant schema.
      if (process.env.SYNC_EVENTS_ENABLED === 'true'
        && process.env.LEGACY_ATTENDANCE_JOBS_ENABLED === 'true') {
        // Run every 2 minutes by default (more reasonable for external API calls)
        const cronSchedule = process.env.SYNC_EVENTS_CRON || '*/2 * * * *';
        cron.schedule(cronSchedule, () => {
          syncEvents().catch(err => console.error('Cron job error:', err));
        });
        console.log('Events sync cron job scheduled');
        
        // Run initial sync
        syncEvents().catch(err => console.error('Initial sync error:', err));
      }
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
