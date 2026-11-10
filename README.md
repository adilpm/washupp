# Washupp

Washupp is a local pilot for Baraq Car Wash in Dammam, operated by Turboshade Solutions.

## Run locally

1. Install Node.js 24 or later.
2. In the ignored .env, set ADMIN_PHONE and ADMIN_PASSWORD before the first run. The app creates the admin account once, so choose a unique password.
3. Keep OPENROUTESERVICE_API_KEY in .env for immediate-job routing.
4. Run npm start and visit http://localhost:3000.

Sign in as the admin to set up the service menu and add captains. Customers can create their own accounts from the sign-in page. Captains can install the site from a supported browser and share their position while the app is open.

## Pilot defaults

- Sample offers are editable in the admin panel. Customers pay after the wash.
- Bookings must fit between 8 AM and 11 PM Riyadh time. A provisional geographic rectangle limits pins near Dammam. Confirm the actual coverage boundary before launch.
- Immediate jobs use openrouteservice to rank eligible captains. Admins manually assign scheduled bookings and jobs that remain pending.
- Customers see the completed status and private completion photo in My bookings. A notification appears when the page is open and observes completion.
- The pilot supports one company. WhatsApp, web push, and multiple completion photos are still pending.

## VPS preparation

Use HTTPS with a reverse proxy for washupp.turboshade.com and run the process with NODE_ENV=production. By default the app binds to 127.0.0.1:3000. Keep the ignored .env on the server and back up the SQLite database in data/ using a SQLite-aware backup. Set DATA_DIR for a separate persistent volume.
