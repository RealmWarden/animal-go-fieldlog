# Distance tracking

## The constraint

A home-screen web app on iOS gets **no background execution of any kind**. No
background geolocation, no Background Sync, no Periodic Background Sync, no
waking a service worker on a schedule. The app cannot measure a walk it did not
witness, and no amount of cleverness changes that — it is a platform decision,
not a missing feature.

So the app does two things instead.

## 1. Credit the provable minimum (nothing to set up)

| when | what is measured |
|---|---|
| app open | the position watch gives a dense track; consecutive fixes are real walking |
| app closed | the next fix is compared with the last one, and the **straight line** between them is credited |

The straight line is the shortest path you could possibly have taken, so this
can never over-pay. Walk out 2 km and it credits ~2 km. Walk a 5 km loop back to
your door with the app closed the whole time and it credits nothing.

You are always credited **less** than you walked, never more, and you never have
to do anything. Because you open the app to scan things, a walk with a few
sightings on it produces a chain of fixes, and the chain is a decent lower bound.

This also settles §8.2's anti-cheese requirement for free: a car journey fails
the walking-speed test (2.5 m/s) on the bridge and is discarded, GPS jitter
below 5 m is not movement, a fix vaguer than 50 m cannot measure a step, and a
day is capped at 60 km. There is nothing to inflate — the number is a lower
bound on a measured displacement.

## 2. Optional: let Health top it up (one-time setup, ~5 minutes)

Your iPhone has been counting **Walking + Running Distance** all day with its own
always-on hardware, whatever any app is doing. An iOS Shortcut can hand that
figure to the app, which then uses whichever is larger — tracked or reported —
for the day. It never double-counts: the same figure twice is one credit, a
smaller figure is ignored, a larger one tops up by the difference.

**Build the Shortcut**

1. Shortcuts → **+** → search **Find Health Samples**.
2. Set it to **Walking + Running Distance**, sort by **Start Date**, and limit
   the range to **Today**.
3. Add **Calculate Statistics** → **Sum** over those samples. (The result is in
   your Health units — kilometres or miles.)
4. Add **Text**, and put this in it, inserting the sum where marked:

   ```
   https://realmwarden.github.io/animal-go-fieldlog/?km=[Sum]
   ```

   If your Health app is set to miles, use `?m=` with the sum multiplied by
   1609 instead — the app reads `km` as kilometres and `m` as metres.
5. Add **Open URLs** with that text.
6. Name it something like *Log my walking*.

**Make it run by itself**

Shortcuts → **Automation** → **+** → **Time of Day** → pick a time you are
usually not mid-something (late evening works). Choose the Shortcut, and turn
**Run Immediately** on so it does not ask. It will open the app for a moment
once a day and the distance will be there.

If you would rather it never interrupt you, skip the automation and just run the
Shortcut from the Home Screen or the Share Sheet whenever you feel like it —
it is idempotent, so running it ten times in a day costs nothing.

## Why not a server

The app has no backend by design, and nothing about your position leaves the
phone. Adding a service to relay step counts would break that for a number the
phone can hand over locally.
