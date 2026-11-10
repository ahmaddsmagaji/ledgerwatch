from fastapi import APIRouter

router = APIRouter()

# --- Shared demo data (single source of truth) ---
def get_transactions_data():
    return [
        {"id": "TXN-88412", "reference": "PAY-88412", "customer": "Aisha Bello", "amount": 250000, "date": "2026-11-08", "channel": "Paystack", "status": "Matched"},
        {"id": "TXN-88413", "reference": "PAY-88413", "customer": "Musa Ibrahim", "amount": 98500, "date": "2026-11-08", "channel": "Flutterwave", "status": "Amount Mismatch"},
        {"id": "TXN-88414", "reference": "PAY-88414", "customer": "Fatima Yusuf", "amount": 150000, "date": "2026-11-07", "channel": "Paystack", "status": "Matched"},
        {"id": "TXN-88415", "reference": "PAY-88415", "customer": "Chinedu Okafor", "amount": 75000, "date": "2026-11-07", "channel": "Monnify", "status": "Missing Settlement"},
        {"id": "TXN-88416", "reference": "PAY-88416", "customer": "Zainab Musa", "amount": 420000, "date": "2026-11-06", "channel": "Paystack", "status": "Matched"},
        {"id": "TXN-88417", "reference": "PAY-88417", "customer": "Ibrahim Sani", "amount": 120000, "date": "2026-11-06", "channel": "Flutterwave", "status": "Duplicate"},
        {"id": "TXN-88418", "reference": "PAY-88418", "customer": "Hauwa Ali", "amount": 98500, "date": "2026-11-05", "channel": "Paystack", "status": "Matched"},
        {"id": "TXN-88419", "reference": "PAY-88419", "customer": "Yusuf Ahmed", "amount": 96500, "date": "2026-11-05", "channel": "Paystack", "status": "Amount Mismatch"},
        {"id": "TXN-88420", "reference": "PAY-88420", "customer": "Grace Eze", "amount": 300000, "date": "2026-11-04", "channel": "Monnify", "status": "Matched"},
        {"id": "TXN-88421", "reference": "PAY-88421", "customer": "Abubakar Kano", "amount": 55000, "date": "2026-11-04", "channel": "Flutterwave", "status": "Timing Difference"},
    ]

def get_settlements_data():
    return [
        {"id": "SET-99101", "provider": "Paystack", "reference": "PAY-88412", "gross": 250000, "fee": 3750, "net": 246250, "date": "2026-11-09", "bank": "【entity-GTBank¦canonical_name=GTBank】 ****4521", "status": "Received"},
        {"id": "SET-99102", "provider": "Flutterwave", "reference": "PAY-88413", "gross": 98500, "fee": 1477.50, "net": 97022.50, "date": "2026-11-09", "bank": "【entity-Access¦canonical_name=Access Bank】 ****8901", "status": "Fee Discrepancy"},
        {"id": "SET-99103", "provider": "Paystack", "reference": "PAY-88414", "gross": 150000, "fee": 2250, "net": 147750, "date": "2026-11-08", "bank": "【entity-GTBank¦canonical_name=GTBank】 ****4521", "status": "Received"},
        {"id": "SET-99104", "provider": "Monnify", "reference": "PAY-88416", "gross": 420000, "fee": 6300, "net": 413700, "date": "2026-11-07", "bank": "FirstBank ****2210", "status": "Received"},
        {"id": "SET-99105", "provider": "Flutterwave", "reference": "PAY-88417", "gross": 120000, "fee": 1800, "net": 118200, "date": "2026-11-07", "bank": "【entity-Access¦canonical_name=Access Bank】 ****8901", "status": "Duplicate"},
        {"id": "SET-99106", "provider": "Paystack", "reference": "PAY-88418", "gross": 98500, "fee": 1477.50, "net": 97022.50, "date": "2026-11-06", "bank": "【entity-GTBank¦canonical_name=GTBank】 ****4521", "status": "Received"},
        {"id": "SET-99107", "provider": "Paystack", "reference": "PAY-88419", "gross": 96500, "fee": 1447.50, "net": 95052.50, "date": "2026-11-06", "bank": "【entity-GTBank¦canonical_name=GTBank】 ****4521", "status": "Amount Mismatch"},
        {"id": "SET-99108", "provider": "Monnify", "reference": "PAY-88420", "gross": 300000, "fee": 4500, "net": 295500, "date": "2026-11-05", "bank": "FirstBank ****2210", "status": "Received"},
        {"id": "SET-99109", "provider": "Paystack", "reference": "ORPHAN-001", "gross": 461132, "fee": 0, "net": 461132, "date": "2026-11-05", "bank": "GTBank ****4521", "status": "Orphan Bank Credit"},
        {"id": "SET-99110", "provider": "Flutterwave", "reference": "PAY-88421", "gross": 55000, "fee": 825, "net": 54175, "date": "2026-11-04", "bank": "Access ****8901", "status": "Timing Difference"},
    ]

def build_reconcile_result():
    txns = get_transactions_data()
    sets = get_settlements_data()
    set_by_ref = {s["reference"]: s for s in sets}
    matched = []
    exceptions = []
    for t in txns:
        s = set_by_ref.get(t["reference"])
        if not s:
            exceptions.append({"id": f"EXC-{t['id'][-3:]}", "txn": t["id"], "reference": t["reference"], "type": "Missing Settlement", "amount": t["amount"], "detail": f"No settlement found for {t['reference']}. Expected {t['amount']}, received 0."})
        elif s["gross"] != t["amount"]:
            exceptions.append({"id": f"EXC-{t['id'][-3:]}", "txn": t["id"], "reference": t["reference"], "type": "Amount Mismatch", "amount": t["amount"], "detail": f"Internal {t['amount']} vs Settlement gross {s['gross']}."})
        elif s["status"] in ["Duplicate", "Fee Discrepancy", "Orphan Bank Credit", "Timing Difference"]:
            exceptions.append({"id": f"EXC-{t['id'][-3:]}", "txn": t["id"], "reference": t["reference"], "type": s["status"], "amount": t["amount"], "detail": f"Settlement {s['id']} flagged as {s['status']}."})
        else:
            matched.append({"txn": t["id"], "settlement": s["id"], "reference": t["reference"], "amount": t["amount"], "net": s["net"]})
    txn_refs = {t["reference"] for t in txns}
    for s in sets:
        if s["reference"] not in txn_refs:
            exceptions.append({"id": "EXC-ORP", "txn": "-", "reference": s["reference"], "type": "Orphan Bank Credit", "amount": s["net"], "detail": f"Bank credit {s['id']} of {s['net']} has no matching internal transaction."})
    total = len(txns)
    rate = round(len(matched) / total * 100, 1) if total else 0
    return {"run_id": "REC-2026-104", "total": total, "matched": len(matched), "exceptions_count": len(exceptions), "rate": rate, "matched_list": matched, "exceptions": exceptions}

@router.get("/overview")
def get_overview():
    return {
        "transactions": 12846, "total_value": 48650000, "settlements_received": 46920000,
        "open_exceptions": 37, "reconciliation_rate": 96.4,
        "flagged_total": 2420712.82, "flagged_count": 44, "resolved_count": 0,
        "breakdown": [
            {"label": "Missing settlement", "count": 12, "pct": "44.7%", "amount": 1081877.00},
            {"label": "Duplicate", "count": 6, "pct": "20.1%", "amount": 486099.45},
            {"label": "Orphan bank credit", "count": 4, "pct": "19.0%", "amount": 461132.00},
            {"label": "Timing break", "count": 6, "pct": "16.1%", "amount": 390166.37},
            {"label": "Fee discrepancy", "count": 8, "pct": "0.0%", "amount": 938.00},
            {"label": "Amount mismatch", "count": 8, "pct": "0.0%", "amount": 500.00},
        ]
    }

@router.get("/transactions")
def get_transactions():
    return get_transactions_data()

@router.get("/settlements")
def get_settlements():
    return get_settlements_data()

@router.post("/reconcile")
def run_reconcile():
    return build_reconcile_result()

@router.get("/exceptions")
def get_exceptions():
    return build_reconcile_result()["exceptions"]

@router.post("/exceptions/{exc_id}/resolve")
def resolve_exception(exc_id: str, payload: dict):
    return {"ok": True, "id": exc_id, "status": "Resolved", "reason": payload.get("reason", ""), "note": payload.get("note", ""), "assignee": payload.get("assignee", "Ahmad Magaji")}