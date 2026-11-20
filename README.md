# Expense Splitter

A web app for splitting shared costs with friends and roommates. Make a group, add what you
paid for, choose who it's split between, and the app works out the fewest payments that
settle everyone up. It installs on Android and iPhone home screens like a regular app.

**Live app:** https://expense-splitter-2dua.onrender.com (free hosting, so the first visit after a quiet spell takes about a minute to wake up)

## Features

- **Profiles:** sign up and log in with a username and password.
- **Groups:** create a group and invite people with a private link, or add friends directly.
- **Friends:** search for people by username and add them as friends.
- **Just the two of you:** tap a friend to add expenses and payments with them alone, no group needed. The friends list shows who owes whom.
- **Expenses:** record who paid and split the cost equally between everyone or chosen people.
  Uneven amounts are split to the cent ($100.00 between 3 is $33.34, $33.33 and $33.33).
- **Settle up:** see who should pay whom, and record payments made in cash or by bank transfer.
- **Personal view:** each person sees "You owe", "You lent" and "You borrowed" from their own
  point of view, plus their total across all groups.
- **Live updates:** changes made by others appear within a few seconds, without refreshing.
- **Installable:** works as a Progressive Web App with an app icon, full-screen mode and an
  offline screen.

## How it works

- **Backend:** Node.js with no web framework: routing, cookies and JSON handling are written
  by hand with the built-in `http` module.
- **Database:** SQLite. Locally it uses the SQLite built into Node; when hosted it uses
  [Turso](https://turso.tech), a hosted SQLite database. A small layer (`db.js`) lets the same
  code run on both.
- **Frontend:** plain HTML, CSS and JavaScript, built mobile-first.

### Money

- All amounts are stored as **whole cents** (integers), never as decimals, to avoid
  floating-point rounding errors.
- Balances are worked out on the server: a person's balance is what they paid, minus their
  shares of expenses, plus payments they made, minus payments they received.
- **Settle-up suggestions** use a greedy algorithm: the person who owes the most pays the person
  who is owed the most, repeated until everyone is at zero. This keeps the number of payments low.

### Security

- Passwords are hashed with **scrypt** and a random salt; plain passwords are never stored.
- Logins use random session tokens in **HttpOnly, SameSite** cookies (and **Secure** over
  HTTPS). Only a SHA-256 hash of each token is stored in the database.
- Repeated wrong passwords for a username are limited to 10 tries per 15 minutes.
- The API only accepts JSON request bodies, which blocks forms posted from other websites.
- Every group request checks that the person is a member of that group. Group links contain
  an unguessable random code.
- User input is always written into the page as text, never as HTML.

## Running it on your computer

You need [Node.js](https://nodejs.org) 22.13 or newer. Nothing else needs installing.

```bash
node server.js
```

Then open http://localhost:3000. Data is saved in a file called `splitter.db`.

On a Mac you can also double-click `start-server.command`, which prints the address to use from
phones on the same Wi-Fi.

## Hosting it

The app is hosted on [Render](https://render.com) (free web service) with the database on
[Turso](https://turso.tech) (free plan).

1. Create a Turso database and an auth token for it.
2. On Render, create a **Web Service** from this repository:
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. Add two environment variables on Render: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.

The server creates its tables on first start.

## Project structure

```
server.js              API routes, sessions, balances and settle-up logic
db.js                  Database layer: built-in SQLite locally, Turso when hosted
public/index.html      All screens
public/app.js          Screen logic and calls to the API
public/style.css       Styles
public/sw.js           Service worker (offline screen, installability)
public/manifest.webmanifest   App name, colors and icons for installing
```

## What I'd add next

- An Android app on Google Play, packaged from the web app as a Trusted Web Activity
- Splitting by exact amounts or percentages
- Push notifications when someone adds an expense
