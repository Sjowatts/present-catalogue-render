# Moving Ffi's Presents to London (Fly.io)

Why: shops decide the currency from where a visitor connects. On Render the app connects from Frankfurt,
so some shops show euros. On Fly.io it can run in London, so shops show pounds. This setup also includes
a real browser, so shops that draw their prices with JavaScript can be read.

Your links and notes stay where they are (the Neon database). Only the app moves.

**Cost:** Fly.io asks for a card. The machine here (1 GB, stops itself when nobody is using it) usually costs
a few dollars a month, but check Fly's pricing page and your dashboard. The first visit after a quiet spell
takes a few seconds while the machine wakes up.

## One-time setup (about 15 minutes, on your Mac)

1. Install the Fly tool: open Terminal and run `brew install flyctl`
   (no Homebrew? see https://fly.io/docs/flyctl/install/).
2. Make an account and add a card: `fly auth signup` (or `fly auth login` if you have one).
3. Get the code: `git clone https://github.com/Sjowatts/present-catalogue-render` then `cd present-catalogue-render`.
4. Create the app, without deploying yet:
   `fly launch --copy-config --no-deploy`
   When it asks, keep the existing `fly.toml`, pick a unique app name, and choose **London (lhr)** as the region.
   Say **no** to adding a database.
5. Give it your secrets (use the same database address that Render uses):
   `fly secrets set DATABASE_URL="paste-your-neon-address-here"`
   Optional: `fly secrets set APP_PASSWORD="a-password"` and `fly secrets set NTFY_TOPIC="your-secret-topic"`
   and `fly secrets set REFRESH_TOKEN="a-long-random-string"` (for the daily automatic price check).
6. Deploy: `fly deploy`. The first build takes a few minutes.
7. Open it: `fly open`. Check `/healthz` shows `"db":true`.

## Switching over

- In GitHub (repo Settings, Secrets and variables, Actions) change the `APP_URL` secret to your new address,
  for example `https://ffis-presents.fly.dev`. If you use the daily price check, make sure the `REFRESH_TOKEN`
  secret there matches the one you set on Fly.
- Update any shared links you sent: they start with the new address now.
- When you're happy, suspend the Render service so you aren't running two copies. Don't delete the
  Neon database: both copies use it.

## Updating later

After a change is merged: `git pull` then `fly deploy`.

## If something goes wrong

- `fly logs` shows what the app is saying.
- `fly status` shows whether the machine is running.
- The app needs at least 1 GB of memory for the browser; if it keeps restarting, run `fly scale memory 2048`.
