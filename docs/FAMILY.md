# Family pages

One website, a private page for each person (for example `/mum`, `/dad`). Each page has its own presents,
lists, budgets, price history, alerts and share links. Nobody can see anyone else's page. Each has a PIN.
Your own site, at the plain address, stays as it was.

## Setting it up (once)

1. **Set a password for the site.** In Render open the service, then **Environment**, and add `APP_PASSWORD`
   with a password only you know. Save and let it redeploy. Without it, anyone who finds the address could open
   your site and the Family button, so the Family button refuses to work until it is set.
2. Open your site. The browser asks for a password: leave the username as anything and type the password.
3. Press **Family**. The names are filled in; change them if you like (commas or new lines) and press
   **Create pages**.
4. Each person's address and a six-digit PIN appear **once**. Press **Copy message** next to each name and send
   it to them (or **Copy all messages**). Their PIN can't be shown again, but **New PIN** makes a fresh one.

## For each person

- They open their own address, type their PIN and use the site exactly like yours.
- **Change PIN** lets them pick a PIN they'll remember. **Sign out** locks it again on that device.
- They set up their own **Notifications**, so price changes (up or down 2%+) and "someone is getting this" messages go to their own phone. Use a topic only the organiser subscribes to if the list is a surprise.
- They can install their page as an app on their phone (**Add from phone**).

- Every page has a **Family** row with everyone's name. Tapping a name opens that person's page. It still asks for
  that person's PIN, unless this device is already signed in there, so nobody's presents are opened by the menu.

## You (the owner)

- You can open any page without its PIN: you are already signed in with the site password.
- **Family** also shows how many presents each page has, and lets you make a new PIN or delete a page
  (deleting removes everything in it, and asks first).

## Backups

The nightly backup (GitHub, **Actions**, **Nightly backup**) saves your site and every family page into one file.
For that to work once `APP_PASSWORD` is set, add a GitHub secret named `APP_PASSWORD` with the same password
(repo **Settings**, **Secrets and variables**, **Actions**). The file never contains PINs or share links.

To bring one person's things back: open their page (you can, as the owner), press **Import**, and choose the
backup file. It takes the part for that page. If the page itself is gone, make it again with **Family** (it gets
a new PIN) and then import.

## Good to know

- A wrong PIN eight times in ten minutes locks that page for a few minutes (the owner's **New PIN** clears it).
- PINs are stored scrambled, so not even you can read them; only replace them.
- All pages share one database and one server, so nothing extra is needed beyond what you already have.

## Share everything

On any page, **Share everything** makes one private link (`/w/<code>`) covering that person's whole page: every list, with pictures, prices and working product links. Anyone with the link can look and tick "I'll get this", but can't change anything and never sees notes or other people's pages. "Stop sharing" kills the link; making a new one gives a different address. Deleting a person's page also kills its link. (Each list still has its own single-list link from its **Share** button.)
