"""Hostile dataset: the clean synthetic data plus cases the engine was NOT designed around.

ALL DATA IS FAKE. Used only by the stress test. The matching engine and the
classifier never see the answer key.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from app.services.synthetic import expected_fee, generate

HOSTILE_DIR = Path(__file__).resolve().parents[3] / "data" / "hostile"
HOSTILE_SEED = 4242


def _mangle(ref: str, n: int) -> str:
    style = n % 3
    if style == 0:
        return ref.lower()
    if style == 1:
        return ref.replace("-", "")
    return ref.replace("-", " ")


def build_hostile(seed: int = HOSTILE_SEED) -> dict:
    data = generate(seed)
    orders, lines, bank = data["orders"], data["settlements"], data["bank"]
    planted = data["answer_key"]["planted_exceptions"]
    baseline_mangled = data["answer_key"]["mangled_references_not_exceptions"]
    counters = {"order": 90000, "line": 900000, "bank": 900000, "amount": 0, "mangle": 0}
    cases = []

    def unique_amount() -> int:
        # Odd kobo (…37): the clean data only has whole-naira amounts, so these never collide with it.
        counters["amount"] += 1
        return (30_000 + 1_000 * counters["amount"]) * 100 + 37

    def mangled(ref: str) -> str:
        counters["mangle"] += 1
        return _mangle(ref, counters["mangle"])

    def new_order(amount_kobo: int, placed: date) -> str:
        counters["order"] += 1
        ref = f"ORD-{counters['order']}"
        orders.append(
            {
                "order_ref": ref,
                "customer_name": "Hostile Case Customer",
                "amount_kobo": amount_kobo,
                "ordered_at": datetime(placed.year, placed.month, placed.day, 10, 0),
            }
        )
        return ref

    def new_line(shown_ref: str, gross: int, settled_on: date) -> dict:
        counters["line"] += 1
        fee = expected_fee(gross)
        line = {
            "processor_ref": f"PR-{counters['line']}",
            "order_ref": shown_ref,
            "batch_id": f"BATCH-{settled_on:%Y%m%d}",
            "gross_kobo": gross,
            "fee_kobo": fee,
            "net_kobo": gross - fee,
            "settled_date": settled_on,
        }
        lines.append(line)
        return line

    def plant(kind, order_ref, settlement_ref, bank_ref, risk, note) -> None:
        planted.append(
            {
                "type": kind,
                "order_ref": order_ref,
                "settlement_ref": settlement_ref,
                "bank_ref": bank_ref,
                "amount_at_risk_kobo": risk,
                "note": note,
            }
        )

    # Case 1: same-amount collisions. Everything was paid correctly, but the references are
    # mangled and two orders share an amount and date, so the engine cannot tell them apart.
    for pair in range(3):
        amount = unique_amount()
        placed = date(2026, 10, 8) + timedelta(days=pair)
        for _copy in range(2):
            ref = new_order(amount, placed)
            new_line(mangled(ref), amount, placed + timedelta(days=1))
    cases.append(
        {
            "name": "same_amount_collisions",
            "count": 6,
            "ground_truth": "No exceptions: all 6 orders were paid correctly.",
            "engine_limit": "Cannot tell same-amount orders apart, so it refuses to guess and raises false alarms.",
        }
    )

    # Case 2: mangled reference AND settled 20 days late (outside the 14-day matching window).
    for i in range(4):
        amount = unique_amount()
        placed = date(2026, 10, 3) + timedelta(days=i)
        ref = new_order(amount, placed)
        line = new_line(mangled(ref), amount, placed + timedelta(days=20))
        plant(
            "timing_break", ref, line["processor_ref"], None, line["net_kobo"],
            "Reference is mangled and the line settled 20 days after the order.",
        )
    cases.append(
        {
            "name": "late_and_mangled",
            "count": 4,
            "ground_truth": "timing_break",
            "engine_limit": "Matching window is 14 days, so a late line with a bad reference is never linked.",
        }
    )

    # Case 3: mangled reference AND a wrong gross amount (so amount matching cannot rescue it).
    for i in range(4):
        amount = unique_amount()
        diff = 7_500 * (i + 1)
        placed = date(2026, 10, 6) + timedelta(days=i)
        ref = new_order(amount, placed)
        line = new_line(mangled(ref), amount + diff, placed + timedelta(days=1))
        plant(
            "amount_mismatch", ref, line["processor_ref"], None, diff,
            "Reference is mangled and the settled gross differs from the order amount.",
        )
    cases.append(
        {
            "name": "mangled_and_wrong_amount",
            "count": 4,
            "ground_truth": "amount_mismatch",
            "engine_limit": "Tier 2 needs an exact amount, so a wrong amount plus a bad reference cannot be linked.",
        }
    )

    # Case 4: duplicate line where BOTH copies have mangled references.
    for i in range(3):
        amount = unique_amount()
        placed = date(2026, 10, 12) + timedelta(days=i)
        ref = new_order(amount, placed)
        new_line(mangled(ref), amount, placed + timedelta(days=1))
        second = new_line(mangled(ref), amount, placed + timedelta(days=1))
        plant(
            "duplicate", ref, second["processor_ref"], None, second["net_kobo"],
            "The order appears twice in the settlement report, both times with a mangled reference.",
        )
    cases.append(
        {
            "name": "both_copies_mangled",
            "count": 3,
            "ground_truth": "duplicate",
            "engine_limit": "With two equally good lines it refuses to pick the real one, so the duplicate is hidden.",
        }
    )

    # Recompute every bank credit from the final settlement lines so the clean parts stay consistent.
    totals, settled_on = defaultdict(int), {}
    for line in lines:
        totals[line["batch_id"]] += line["net_kobo"]
        settled_on[line["batch_id"]] = line["settled_date"]
    by_batch = {b["batch_id"]: b for b in bank if b["batch_id"]}
    for batch_id in sorted(totals):
        if batch_id in by_batch:
            by_batch[batch_id]["amount_kobo"] = totals[batch_id]
        else:
            counters["bank"] += 1
            row = {
                "batch_id": batch_id,
                "narration": f"PAYRAIL SETTLEMENT {batch_id} NIP",
                "amount_kobo": totals[batch_id],
                "value_date": settled_on[batch_id] + timedelta(days=1),
                "bank_ref": f"BNK-{counters['bank']}",
            }
            bank.append(row)
            by_batch[batch_id] = row

    # Case 5a: an extra credit with exactly the same amount and date as a real payout.
    batch_ids = sorted(totals)
    for batch_id in (batch_ids[8], batch_ids[16]):
        twin = by_batch[batch_id]
        counters["bank"] += 1
        extra = {
            "batch_id": None,
            "narration": "NIP CREDIT MISC",
            "amount_kobo": twin["amount_kobo"],
            "value_date": twin["value_date"],
            "bank_ref": f"BNK-{counters['bank']}",
        }
        bank.append(extra)
        plant(
            "orphan_bank_credit", None, None, extra["bank_ref"], extra["amount_kobo"],
            "A second credit with the same amount and date as a real batch payout, with no batch behind it.",
        )
    cases.append(
        {
            "name": "orphan_equals_batch_total",
            "count": 2,
            "ground_truth": "orphan_bank_credit (the extra credit only)",
            "engine_limit": "Two credits fit one batch, so it links neither and flags both as orphans.",
        }
    )

    # Case 5b: a payout that arrives short. The engine has no concept of this problem.
    short = by_batch[batch_ids[4]]
    shortfall = 150_000
    short["amount_kobo"] -= shortfall
    plant(
        "batch_shortfall", None, None, short["bank_ref"], shortfall,
        "The bank credit is NGN 1,500.00 less than the sum of the batch it should pay.",
    )
    cases.append(
        {
            "name": "short_paid_batch",
            "count": 1,
            "ground_truth": "batch_shortfall (a type the classifier does not have)",
            "engine_limit": "Needs exact sums, so it flags the short credit as an orphan instead of recognising a shortfall.",
        }
    )

    planted.sort(key=lambda e: (e["type"], e["order_ref"] or "", e["bank_ref"] or ""))
    data["answer_key"] = {
        "WARNING": "For scoring only. The matching engine must never read this file.",
        "seed": seed,
        "total_planted": len(planted),
        "planted_exceptions": planted,
        "mangled_references_not_exceptions": baseline_mangled,
        "hostile_cases": cases,
    }
    return data
