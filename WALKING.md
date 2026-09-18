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

## 2. Let Health do it properly (one-time setup, ~5 minutes)

**This is the better number, and once it is set up it is the one the app uses.**
Your iPhone counts **Walking + Running Distance** all day with its own always-on
motion hardware, whatever any app is doing. It is more accurate than a chain of
GPS fixes and it does not care whether the app was open.

The reason it is not simply the default is narrow and absolute: **a web app
cannot read Health.** There is no web API for HealthKit, at any permission
level, so there is nothing for the app to default *to* until you build the
bridge once. After that the app takes whichever figure is larger for the day,
which is almost always Health.

**Build the Shortcut**

1. Shortcuts → **+** → search **Find Health Samples**.
2. Set it to **Walking + Running Distance**, and limit the range to **Today**.
3. Add **Calculate Statistics** → **Sum** over those samples. The result is in
   your Health units — kilometres or miles.
4. Add **Text**, and put this in it, inserting the sum where marked:

   ```
   https://realmwarden.github.io/animal-go-fieldlog/?km=[Sum]
   ```

   If Health is set to miles, multiply the sum by 1609 and use `?m=` instead:
   the app reads `km` as kilometres and `m` as metres.
5. Add **Open URLs** with that text.
6. Name it something like *Log my walking*.

**Make it run by itself — use Arrive, not Time of Day**

Shortcuts → **Automation** → **+** → **Arrive** → your home address → turn
**Run Immediately** on.

Arrive is the right trigger for three reasons: it fires right after a walk
rather than at an arbitrary hour, it never interrupts you mid-something, and a
Time of Day automation can be delayed or skipped entirely if the phone has not
been unlocked. Several arrivals in a day cost nothing — the app takes a maximum,
not a sum, so the same figure twice is one credit and a larger one later just
tops up the difference.

You can add a late-evening **Time of Day** automation as well if you want a
backstop for days you never leave or never come home.

## What each source is good for

| | tracked by the app | reported by Health |
|---|---|---|
| setup | none | one Shortcut, once |
| accuracy | a lower bound, sometimes well under | the real figure |
| counts indoor walking, treadmills | no | yes |
| knows *where* you walked | yes — feeds the locality dex | no, it is a day total |
| works with the phone locked | yes, as a straight line | yes |

They are not redundant. Health gives the honest distance; the GPS track is what
will eventually place a walk on a map and fill a regional dex, which a daily
total can never do.

## Why not a server

The app has no backend by design, and nothing about your position leaves the
phone. Adding a service to relay step counts would break that for a number the
phone can hand over locally.
