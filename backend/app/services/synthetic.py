"""Synthetic data for Ledgerwatch. ALL DATA HERE IS FAKE.

Generates three CSV files in the format of a fictional processor ("PayRail")
and a fictional bank, plus an answer key listing every planted error.
The matching engine must never read the answer key; only the scoring script does.
"""

import csv
import json
import random
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[3] / "data" / "synthetic"

SEED = 2026
N_ORDERS = 500
START_DATE = date(2026, 10, 1)
FEE_PERMILLE = 15        # PayRail charges 1.5% ...
FEE_CAP_KOBO = 200_000   # ... capped at NGN 2,000
SLA_DAYS = 3             # settlements should arrive within this many days

PLANTED = {
    "missing_settlement": 12,
    "amount_mismatch": 8,
    "duplicate": 6,
    "fee_discrepancy": 8,
    "timing_break": 6,
}
SETTLEMENT_ERRORS = ("amount_mismatch", "duplicate", "fee_discrepancy", "timing_break")
N_ORPHANS = 4
N_MANGLED = 25

FIRST_NAMES = [
    "Ibrahim", "Aisha", "Chinedu", "Funmilayo", "Musa", "Ngozi", "Sadiq", "Blessing",
    "Yusuf", "Amaka", "Hauwa", "Tunde", "Zainab", "Emeka", "Fatima", "Segun",
]
LAST_NAMES = [
    "Abdullahi", "Okafor", "Bello", "Adeyemi", "Danjuma", "Eze", "Sani", "Balogun",
    "Garba", "Nwosu", "Lawal", "Ogunleye", "Usman", "Obi", "Musa",
]
ORPHAN_NARRATIONS = ["TRF FROM UNKNOWN SENDER", "NIP CREDIT MISC", "REVERSAL ADJ UNREF"]


def kobo_to_ngn(kobo: int) -> str:
    """Integer kobo -> '10000.00' using integer math only."""
    return f"{kobo // 100}.{kobo % 100:02d}"


def expected_fee(gross_kobo: int) -> int:
    """PayRail's published fee: 1.5% rounded half-up to the kobo, capped."""
    return min((gross_kobo * FEE_PERMILLE + 500) // 1000, FEE_CAP_KOBO)


def mangle_ref(ref: str, rng: random.Random) -> str:
    style = rng.choice(["lower", "no_hyphen", "space"])
    if style == "lower":
        return ref.lower()
    if style == "no_hyphen":
        return ref.replace("-", "")
    return ref.replace("-", " ")


def _entry(kind, order_ref, settlement_ref, bank_ref, risk_kobo, note) -> dict:
    return {
        "type": kind,
        "order_ref": order_ref,
        "settlement_ref": settlement_ref,
        "bank_ref": bank_ref,
        "amount_at_risk_kobo": risk_kobo,
        "note": note,
    }


def generate(seed: int = SEED) -> dict:
    rng = random.Random(seed)

    # 1. Orders
    orders = []
    for i in range(1, N_ORDERS + 1):
        placed = START_DATE + timedelta(days=rng.randrange(30))
        orders.append(
            {
                "order_ref": f"ORD-{i:05d}",
                "customer_name": f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}",
                "amount_kobo": rng.randrange(2_000, 150_001) * 100,
                "ordered_at": datetime(
                    placed.year, placed.month, placed.day,
                    rng.randrange(8, 21), rng.randrange(60),
                ),
            }
        )

    # 2. Decide which orders carry which planted error (no order gets two)
    refs = [o["order_ref"] for o in orders]
    rng.shuffle(refs)
    pools, cursor = {}, 0
    for kind, count in PLANTED.items():
        pools[kind] = set(refs[cursor:cursor + count])
        cursor += count
    mangled = set(refs[cursor:cursor + N_MANGLED])  # clean orders with a typo'd reference

    # 3. Settlement lines
    settlements, planted, mangled_log = [], [], []
    counter = 0

    def add_line(shown_ref, gross, fee, settled_on):
        nonlocal counter
        counter += 1
        line = {
            "processor_ref": f"PR-{counter:06d}",
            "order_ref": shown_ref,
            "batch_id": f"BATCH-{settled_on:%Y%m%d}",
            "gross_kobo": gross,
            "fee_kobo": fee,
            "net_kobo": gross - fee,
            "settled_date": settled_on,
        }
        settlements.append(line)
        return line

    for o in orders:
        ref = o["order_ref"]
        order_gross = o["amount_kobo"]
        placed = o["ordered_at"].date()

        if ref in pools["missing_settlement"]:
            planted.append(
                _entry("missing_settlement", ref, None, None, order_gross,
                       "Order has no line in the settlement report.")
            )
            continue

        kind = next((k for k in SETTLEMENT_ERRORS if ref in pools[k]), None)
        gross = order_gross
        lag = rng.randrange(1, 3)

        if kind == "amount_mismatch":
            gross += rng.choice([-1, 1]) * rng.randrange(10, 100) * 100
        fee = expected_fee(gross)
        extra_fee = 0
        if kind == "fee_discrepancy":
            extra_fee = rng.randrange(20, 200) * 100
            fee += extra_fee
        if kind == "timing_break":
            lag = rng.randrange(8, 13)

        shown = ref
        if ref in mangled:
            shown = mangle_ref(ref, rng)
            mangled_log.append({"order_ref": ref, "appears_as": shown})

        line = add_line(shown, gross, fee, placed + timedelta(days=lag))

        if kind == "amount_mismatch":
            planted.append(
                _entry(kind, ref, line["processor_ref"], None, abs(gross - order_gross),
                       f"Order is NGN {kobo_to_ngn(order_gross)} but the processor settled "
                       f"a gross of NGN {kobo_to_ngn(gross)}.")
            )
        elif kind == "fee_discrepancy":
            planted.append(
                _entry(kind, ref, line["processor_ref"], None, extra_fee,
                       f"Fee charged is NGN {kobo_to_ngn(fee)}; the agreed rate gives "
                       f"NGN {kobo_to_ngn(expected_fee(gross))}.")
            )
        elif kind == "timing_break":
            planted.append(
                _entry(kind, ref, line["processor_ref"], None, line["net_kobo"],
                       f"Settled {lag} days after the order; expected within {SLA_DAYS} days.")
            )
        elif kind == "duplicate":
            dup = add_line(shown, gross, fee, line["settled_date"])
            planted.append(
                _entry(kind, ref, dup["processor_ref"], None, dup["net_kobo"],
                       "The same order appears twice in the settlement report.")
            )

    settlements.sort(key=lambda s: (s["settled_date"], s["processor_ref"]))

    # 4. Bank credits: one per settlement batch, equal to the sum of net amounts
    totals = defaultdict(lambda: [0, None])
    for s in settlements:
        totals[s["batch_id"]][0] += s["net_kobo"]
        totals[s["batch_id"]][1] = s["settled_date"]

    bank = [
        {
            "batch_id": batch_id,
            "narration": f"PAYRAIL SETTLEMENT {batch_id} NIP",
            "amount_kobo": total,
            "value_date": settled_on + timedelta(days=1),
        }
        for batch_id, (total, settled_on) in totals.items()
    ]
    for _ in range(N_ORPHANS):  # credits with no matching settlement batch
        bank.append(
            {
                "batch_id": None,
                "narration": rng.choice(ORPHAN_NARRATIONS),
                "amount_kobo": rng.randrange(5_000, 200_001) * 100,
                "value_date": START_DATE + timedelta(days=rng.randrange(30)),
            }
        )
    bank.sort(key=lambda b: (b["value_date"], b["narration"]))
    for n, b in enumerate(bank, start=1):
        b["bank_ref"] = f"BNK-{n:06d}"

    # 5. Fill in bank references for the answer key
    bank_ref_of_batch = {b["batch_id"]: b["bank_ref"] for b in bank if b["batch_id"]}
    batch_of_line = {s["processor_ref"]: s["batch_id"] for s in settlements}
    for e in planted:
        if e["settlement_ref"]:
            e["bank_ref"] = bank_ref_of_batch[batch_of_line[e["settlement_ref"]]]
    for b in bank:
        if b["batch_id"] is None:
            planted.append(
                _entry("orphan_bank_credit", None, None, b["bank_ref"], b["amount_kobo"],
                       "Bank credit with no matching settlement batch.")
            )

    planted.sort(key=lambda e: (e["type"], e["order_ref"] or "", e["bank_ref"] or ""))

    answer_key = {
        "WARNING": "For scoring only. The matching engine must never read this file.",
        "seed": seed,
        "total_planted": len(planted),
        "planted_exceptions": planted,
        "mangled_references_not_exceptions": sorted(mangled_log, key=lambda m: m["order_ref"]),
    }
    return {"orders": orders, "settlements": settlements, "bank": bank, "answer_key": answer_key}


def _write_csv(path: Path, fieldnames: list, rows: list) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_files(data: dict, out_dir: Path = OUT_DIR) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    _write_csv(
        out_dir / "orders.csv",
        ["order_ref", "customer_name", "amount_ngn", "ordered_at"],
        [
            {
                "order_ref": o["order_ref"],
                "customer_name": o["customer_name"],
                "amount_ngn": kobo_to_ngn(o["amount_kobo"]),
                "ordered_at": o["ordered_at"].strftime("%Y-%m-%d %H:%M"),
            }
            for o in data["orders"]
        ],
    )
    _write_csv(
        out_dir / "settlements.csv",
        ["processor_ref", "order_ref", "batch_id", "gross_ngn", "fee_ngn", "net_ngn", "settled_date"],
        [
            {
                "processor_ref": s["processor_ref"],
                "order_ref": s["order_ref"],
                "batch_id": s["batch_id"],
                "gross_ngn": kobo_to_ngn(s["gross_kobo"]),
                "fee_ngn": kobo_to_ngn(s["fee_kobo"]),
                "net_ngn": kobo_to_ngn(s["net_kobo"]),
                "settled_date": s["settled_date"].isoformat(),
            }
            for s in data["settlements"]
        ],
    )
    _write_csv(
        out_dir / "bank_statement.csv",
        ["bank_ref", "value_date", "narration", "credit_ngn"],
        [
            {
                "bank_ref": b["bank_ref"],
                "value_date": b["value_date"].isoformat(),
                "narration": b["narration"],
                "credit_ngn": kobo_to_ngn(b["amount_kobo"]),
            }
            for b in data["bank"]
        ],
    )
    (out_dir / "answer_key.json").write_text(
        json.dumps(data["answer_key"], indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    data = generate()
    write_files(data)
    print(f"Wrote files to: {OUT_DIR}")
    print(f"orders.csv: {len(data['orders'])} rows")
    print(f"settlements.csv: {len(data['settlements'])} rows")
    print(f"bank_statement.csv: {len(data['bank'])} rows")
    print(f"answer_key.json: {data['answer_key']['total_planted']} planted exceptions")