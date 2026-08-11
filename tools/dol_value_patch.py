#!/usr/bin/env python3
"""Patch a compiled Degrees of Lewdity build to speed up progression.

The compiled game is a single ~50 MB HTML file, so a normal git diff on it is
useless. This script IS the diff: every value change the modded build contains
is listed in EDITS below, as an exact before/after pair against the vanilla
0.5.11.9 text-only build.

Two kinds of anchors appear here:

  * Raw JavaScript, taken from the ``twine-user-script`` block.
  * HTML-escaped Twine markup, taken from a ``<tw-passagedata>`` element.
    Inside those elements ``<`` is ``&lt;`` and ``"`` is ``&quot;``, which is
    why the twee anchors look the way they do.

Rather than hard-coding new numbers at each site, every edit multiplies by a
field of a ``DOLCHEAT`` config object injected at the top of the document. That
keeps all the tuning in one place, and lets you retune a patched build from the
browser console without re-running this script::

    DOLCHEAT.moneyGain = 20        // takes effect on the next payout
    DOLCHEAT.fatigueGain = 1       // back to vanilla fatigue

Usage:
    python3 tools/dol_value_patch.py <vanilla.html> <output.html>
"""

import sys

# --------------------------------------------------------------------------
# Tunables. 1 means "vanilla" for every multiplier below.
# --------------------------------------------------------------------------
CONFIG = """\
<script id="dol-cheat-config" type="text/javascript">
/* Injected by tools/dol_value_patch.py. Every multiplier below is 1 in vanilla,
   so setting a field to 1 restores the original behaviour for that stat. */
window.DOLCHEAT = {
\t/* Money earned is multiplied by this. Money *spent* is left alone, so prices
\t   still read the same in shop text. */
\tmoneyGain: 5,

\t/* Fatigue ($tiredness, 0-2000). Gains are scaled down and rest is scaled up,
\t   which is what actually removes the "go home and sleep" treadmill. */
\tfatigueGain: 0.34,      // fatigue from actions
\tfatigueFromTime: 0.34,  // fatigue from the clock advancing
\tfatigueRecovery: 3,     // sleeping / resting recovers this much faster

\t/* Skill growth. */
\tsexSkillGain: 4,        // oral/vaginal/penile/hand/anal/feet/bottom/thigh/chest,
\t                        // plus seduction, skulduggery and beauty
\tprofGain: 3,            // <<prof>> proficiencies
\tphysiqueGain: 5,
\tathleticsGain: 5,
\tdanceGain: 5,
\ttendingGain: 5,
\thousekeepingGain: 5,
\tswimmingGain: 5,
\tschoolGain: 5,          // english / maths / science / history lesson progress
\tschoolDecay: 0,         // daily decay of exam progress; 1 = vanilla (-7/day)

\t/* Trouble at school: detention, delinquency and suspicion gains. */
\ttroubleGain: 0.25,

\t/* Time scaling. DISABLED BY DEFAULT (1). Setting this below 1 makes actions
\t   take less in-game time, but the school day and some timed events assume
\t   vanilla durations, so it can leave you idling in a lesson that ended early.
\t   Try 0.5 if you want it. Only actions at or under timeCostMaxHours are
\t   scaled, so sleeping and long scenes keep their normal length. */
\ttimeCost: 1,
\ttimeCostMaxHours: 2,

\tscaleTime(seconds) {
\t\tconst k = window.DOLCHEAT.timeCost;
\t\tif (!(k > 0) || k === 1 || seconds <= 0) return seconds;
\t\tif (seconds > window.DOLCHEAT.timeCostMaxHours * 3600) return seconds;
\t\treturn Math.max(1, Math.round(seconds * k));
\t},
};
</script>
"""

ANCHOR = '<script role="script" id="twine-user-script" type="text/twine-javascript">'

# (label, expected occurrences, old, new)
EDITS = [
    # ---------------------------------------------------------------- money
    (
        "money: multiply income, leave spending alone",
        1,
        "\t\t\tV.money += amount;",
        "\t\t\tV.money += amount > 0 ? amount * DOLCHEAT.moneyGain : amount;",
    ),
    # -------------------------------------------------------------- fatigue
    (
        "fatigue: gain from the clock advancing",
        1,
        "V.tiredness += amount * fatigueMod;",
        "V.tiredness += amount * fatigueMod * DOLCHEAT.fatigueFromTime;",
    ),
    (
        "fatigue: gain from actions",
        1,
        "V.tiredness += amount * 15 * fatigueMod;",
        "V.tiredness += amount * 15 * fatigueMod * DOLCHEAT.fatigueGain;",
    ),
    (
        "fatigue: recovery from rest (amount is negative here)",
        1,
        "V.tiredness += amount * 20 * fatigueMod;",
        "V.tiredness += amount * 20 * fatigueMod * DOLCHEAT.fatigueRecovery;",
    ),
    # --------------------------------------------------------------- skills
    (
        "skills: sexual skills, seduction, skulduggery, beauty",
        1,
        "V[type] = Math.clamp(V[type] + amount, 0, maxValue);",
        "V[type] = Math.clamp(V[type] + (amount > 0 ? amount * DOLCHEAT.sexSkillGain : amount), 0, maxValue);",
    ),
    (
        "skills: <<prof>> proficiencies",
        1,
        "V.prof[skill] = Math.clamp((V.prof[skill] || 0) + amount * 5, 0, 1000);",
        "V.prof[skill] = Math.clamp((V.prof[skill] || 0) + amount * 5 * DOLCHEAT.profGain, 0, 1000);",
    ),
    (
        "skills: physique",
        1,
        "&lt;&lt;set $physique += 10 * _temp&gt;&gt;",
        "&lt;&lt;set $physique += 10 * _temp * DOLCHEAT.physiqueGain&gt;&gt;",
    ),
    (
        "skills: athletics",
        1,
        "&lt;&lt;set $athletics += Math.trunc(_temp * 1.3)&gt;&gt;",
        "&lt;&lt;set $athletics += Math.trunc(_temp * 1.3 * DOLCHEAT.athleticsGain)&gt;&gt;",
    ),
    (
        "skills: dancing",
        1,
        "&lt;&lt;set $danceskill += _args[0]&gt;&gt;",
        "&lt;&lt;set $danceskill += _args[0] * DOLCHEAT.danceGain&gt;&gt;",
    ),
    (
        "skills: tending",
        1,
        "&lt;&lt;set $tending += (_args[0] * 2)&gt;&gt;",
        "&lt;&lt;set $tending += (_args[0] * 2 * DOLCHEAT.tendingGain)&gt;&gt;",
    ),
    (
        "skills: housekeeping (both branches of the widget)",
        2,
        "&lt;&lt;set $housekeeping += (_args[0] * 2)&gt;&gt;",
        "&lt;&lt;set $housekeeping += (_args[0] * 2 * DOLCHEAT.housekeepingGain)&gt;&gt;",
    ),
    (
        "skills: swimming",
        1,
        "&lt;&lt;set $swimmingskill += 9&gt;&gt;",
        "&lt;&lt;set $swimmingskill += 9 * DOLCHEAT.swimmingGain&gt;&gt;",
    ),
    # --------------------------------------------------------------- school
    (
        "school: lesson progress towards the next grade",
        1,
        "&lt;&lt;set _skill_mod to [2.4, 1.2, 0.6, 0.3]"
        "[Math.clamp(V[$_subject + &quot;trait&quot;], 0, 3)]&gt;&gt;",
        "&lt;&lt;set _skill_mod to [2.4, 1.2, 0.6, 0.3]"
        "[Math.clamp(V[$_subject + &quot;trait&quot;], 0, 3)] * DOLCHEAT.schoolGain&gt;&gt;",
    ),
]

# The four subjects decay identically each day; generated rather than repeated.
for _subject in ("science", "maths", "english", "history"):
    EDITS.append(
        (
            f"school: daily decay of {_subject} exam progress",
            1,
            f"V.{_subject}_exam = Math.clamp(V.{_subject}_exam - 7, -107, 200);",
            f"V.{_subject}_exam = Math.clamp(V.{_subject}_exam - 7 * DOLCHEAT.schoolDecay, -107, 200);",
        )
    )

EDITS += [
    # -------------------------------------------------------------- trouble
    (
        "trouble: detention gain",
        1,
        "if (amount > 0) V.detention += amount * 10;",
        "if (amount > 0) V.detention += amount * 10 * DOLCHEAT.troubleGain;",
    ),
    (
        "trouble: delinquency from detention",
        1,
        "V.delinquency = Math.clamp(V.delinquency + amount * 4, 0, 1000);",
        "V.delinquency = Math.clamp(V.delinquency + amount * 4 * (amount > 0 ? DOLCHEAT.troubleGain : 1), 0, 1000);",
    ),
    (
        "trouble: delinquency gain",
        1,
        "V.delinquency += amount * 4;",
        "V.delinquency += amount * 4 * (amount > 0 ? DOLCHEAT.troubleGain : 1);",
    ),
    # ----------------------------------------------------------------- time
    (
        "time: route every <<pass>> through DOLCHEAT.scaleTime",
        1,
        "Time.pass(time * multiplier);",
        "Time.pass(DOLCHEAT.scaleTime(time * multiplier));",
    ),
]


def main():
    if len(sys.argv) != 3:
        sys.exit(f"usage: {sys.argv[0]} <vanilla.html> <output.html>")
    src_path, out_path = sys.argv[1], sys.argv[2]

    with open(src_path, encoding="utf-8") as f:
        html = f.read()

    if "window.DOLCHEAT" in html:
        sys.exit("error: this build is already patched. Start from a vanilla build.")

    if html.count(ANCHOR) != 1:
        sys.exit(f"error: expected exactly 1 user-script tag, found {html.count(ANCHOR)}")
    html = html.replace(ANCHOR, CONFIG + ANCHOR, 1)

    for label, expected, old, new in EDITS:
        found = html.count(old)
        if found != expected:
            sys.exit(f"error: {label!r} matched {found} time(s), expected {expected}")
        html = html.replace(old, new)
        print(f"  ok  ({expected}x)  {label}")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\n{len(EDITS)} edits applied -> {out_path}")


if __name__ == "__main__":
    main()
