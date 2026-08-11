# Degrees of Lewdity 0.5.11.9 — value tweaks

Two builds live in this folder:

| File | What it is |
|---|---|
| `Degrees of Lewdity 0.5.11.9 text only.html` | Untouched vanilla build, extracted from the uploaded archive |
| `Degrees of Lewdity 0.5.11.9 text only (cheat).html` | Same build with progression values retuned |

Download the `(cheat)` file and open it in a browser — it is self-contained, same
as the vanilla one. This is the "text only" release, so it has no images; that is
a property of the upload, not of the patch.

Saves are interchangeable between the two builds. The patch only changes
multipliers, never the shape of a saved variable, so you can move a save back to
vanilla whenever you want.

## What changed

`tools/dol_value_patch.py` is the real changelog — it holds all 21 edits as exact
before/after pairs against the vanilla build. The numbers below were measured by
running both builds in a headless browser and calling each macro on a fresh game
state.

| Stat | Test | Vanilla | Patched |
|---|---|---:|---:|
| Money | `<<money 100>>` | +100 | +500 |
| Money | `<<money -100>>` (spending) | −100 | −100 |
| Fatigue | `<<tiredness 10>>` | +150 | +51 |
| Sexual skills | `<<handskill 10>>` | +10 | +40 |
| Physique | `<<physique 1>>` | +10 | +50 |
| Athletics | `<<athletics 1>>` | +1 | +7 |
| Housekeeping | `<<housekeeping 1>>` | +2 | +10 |
| Tending | `<<tending 1>>` | +2 | +10 |
| Dancing | `<<danceskill 1>>` | +1 | +5 |
| School subject | `<<englishskill 1>>` | +2.4 | +12 |
| Detention | `<<detention 1>>` | +10 | +2.5 |
| Delinquency | `<<detention 1>>` | +4 | +1 |

Also changed, and not visible in a single-call test:

- **Rest recovers fatigue 3× faster**, and fatigue accumulated from the clock
  simply advancing is cut to about a third. Together with the reduced action
  cost, this is what actually removes the sleep treadmill.
- **School exam progress no longer decays.** Vanilla drops each subject by 7 per
  day during term; that decay is switched off, so grades only move upward.
- **Suspicion, detention and delinquency gains are quartered**, which is the
  low-risk way to take the pressure off the school schedule.

## Retuning without re-patching

Every multiplier lives on a `DOLCHEAT` object injected at the top of the
document, and is read at the moment a stat changes. So the browser console
retunes a running game:

```js
DOLCHEAT.moneyGain = 20      // even more money, effective on the next payout
DOLCHEAT.fatigueGain = 1     // vanilla fatigue again
DOLCHEAT                     // print everything currently set
```

Setting any field to `1` restores vanilla behaviour for that stat, so nothing
here is a one-way door.

## Time scaling is off by default

`DOLCHEAT.timeCost` scales how much in-game time actions consume. It ships as
`1` (disabled) on purpose: the school day and some timed events assume vanilla
durations, so shortening actions can leave you idling through a lesson that
ended early. If you want it:

```js
DOLCHEAT.timeCost = 0.5      // actions take half as long
```

Anything longer than `DOLCHEAT.timeCostMaxHours` (default 2) is never scaled, so
sleeping and long scenes keep their real length even when this is on. The
scaling itself is verified working — a 60-minute action costs 30 minutes at
`0.5` — but the knock-on effects on the school timetable were not play-tested,
which is why it defaults to off.

## Two things worth knowing

- **Feats still unlock.** The patch does not touch the game's own cheat flag, so
  achievements are not disabled the way the built-in cheat menu disables them.
  If you would rather earn them honestly, this build is not the way to do it.
- **The money statistics page shows base amounts.** The multiplier is applied to
  your wallet, not to the figure recorded in `$moneyStats`, so the stats screen
  will under-report what you actually banked.

## Re-applying the patch to a different build

```
python3 tools/dol_value_patch.py <vanilla.html> <output.html>
```

The script asserts an exact match count for every edit and refuses to write
anything if a single anchor is missing or ambiguous. That means it will fail
loudly rather than silently half-patch when DoL updates and the surrounding code
moves — at which point the anchors need updating for the new version.
