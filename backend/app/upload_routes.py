"""Real user upload: POST 3 CSVs -> import -> reconcile -> return TOTAL/MATCHED/EXCEPTIONS.
No demo data. Each upload replaces the current dataset (single-tenant demo).
For multi-user later, add user_id filter - for now this is the real flow."""
import csv, io
from datetime import datetime
from collections import defaultdict
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse
from app.core.database import SessionLocal
from app.models.tables import Order, Settlement, BankTransaction, Match, ReconException, MatchTier, ExceptionType, ExceptionStatus

router = APIRouter(tags=["upload"])

def pd(s):
    s = (s or "").strip()
    if not s: return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y", "%m/%d/%Y"):
        try: return datetime.strptime(s, fmt)
        except: pass
    try: return datetime.fromisoformat(s)
    except: return None

def parse_csv(file: UploadFile):
    content = file.file.read()
    try: text = content.decode("utf-8-sig")
    except: text = content.decode("latin-1")
    return list(csv.DictReader(io.StringIO(text)))

@router.get("/upload", response_class=HTMLResponse)
def upload_page():
    return """
    <html><head><meta name='viewport' content='width=device-width, initial-scale=1'><title>LedgerWatch - Upload CSVs</title>
    <style>body{font-family:system-ui;max-width:600px;margin:20px auto;padding:16px}label{display:block;margin:14px 0 4px;font-weight:600}input,button{width:100%;padding:10px;margin:4px 0}button{background:#5B0DBA;color:#fff;border:0;border-radius:8px;font-size:16px}</style></head>
    <body><h1>LedgerWatch - Upload Your CSVs</h1><p>Upload your 3 files. Any provider - Paystack, Flutterwave, Monnify. Same columns as demo: orders, settlements, bank.</p>
    <form action='/api/upload' method='post' enctype='multipart/form-data'>
    <label>1. Orders CSV (order_id, payment_reference, order_date, customer, amount_kobo)</label><input type='file' name='orders' accept='.csv' required>
    <label>2. Settlements CSV (settlement_id, payment_reference, settlement_date, gross_kobo, fee_kobo, net_kobo)</label><input type='file' name='settlements' accept='.csv' required>
    <label>3. Bank CSV (bank_transaction_id, transaction_date, description, reference, credit_kobo)</label><input type='file' name='bank' accept='.csv' required>
    <button type='submit'>Upload & Reconcile</button></form>
    <p><a href='/api/upload/result'>View last result (JSON)</a></p></body></html>
    """

@router.post("/api/upload")
async def upload_and_reconcile(orders: UploadFile = File(...), settlements: UploadFile = File(...), bank: UploadFile = File(...)):
    db = SessionLocal()
    try:
        # Clear current dataset
        db.query(Match).delete(); db.query(ReconException).delete()
        db.query(Order).delete(); db.query(Settlement).delete(); db.query(BankTransaction).delete()
        db.commit()
        # Orders
        for row in parse_csv(orders):
            pay = (row.get("payment_reference") or row.get("order_ref") or row.get("reference") or "").strip()
            oid = (row.get("order_id") or pay).strip()
            if not pay: continue
            amt = int(float((row.get("amount_kobo") or row.get("amount") or 0) or 0))
            dt = pd(row.get("order_date") or row.get("ordered_at") or row.get("date")) or datetime.now()
            db.add(Order(order_ref=pay, customer_name=f"{(row.get('customer') or row.get('customer_name') or 'Customer').strip()} ({oid})", amount_kobo=amt, ordered_at=dt))
        db.commit()
        # Settlements - settlement_id is unique, payment_reference is link
        for row in parse_csv(settlements):
            sid = (row.get("settlement_id") or row.get("processor_ref") or "").strip()
            pay = (row.get("payment_reference") or row.get("order_id") or "").strip()
            if not sid: continue
            gross = int(float((row.get("gross_kobo") or row.get("amount_kobo") or row.get("amount") or 0) or 0))
            fee = int(float((row.get("fee_kobo") or row.get("fee") or 0) or 0))
            net_raw = row.get("net_kobo") or row.get("net")
            net = int(float(net_raw)) if net_raw else max(0, gross - fee)
            sd = pd(row.get("settlement_date") or row.get("settled_date") or row.get("date"))
            db.add(Settlement(processor_ref=sid, order_ref=pay or None, batch_id=sid, gross_kobo=gross, fee_kobo=fee, net_kobo=net, settled_date=(sd.date() if sd else datetime.now().date())))
        db.commit()
        # Bank - credit only
        for row in parse_csv(bank):
            bid = (row.get("bank_transaction_id") or row.get("bank_ref") or row.get("reference") or "").strip()
            amt = int(float((row.get("credit_kobo") or row.get("amount_kobo") or row.get("amount") or 0) or 0))
            if not bid or amt <= 0: continue
            desc = (row.get("description") or row.get("narration") or "").strip()
            ref = (row.get("reference") or "").strip()
            vd = pd(row.get("transaction_date") or row.get("value_date") or row.get("date"))
            db.add(BankTransaction(bank_ref=bid, narration=f"{desc} | ref:{ref}"[:255], amount_kobo=amt, value_date=(vd.date() if vd else datetime.now().date())))
        db.commit()
        # Reconcile - same logic as run_recon.py
        all_orders = db.query(Order).all(); all_sett = db.query(Settlement).all(); all_bank = db.query(BankTransaction).all()
        by_pay = defaultdict(list)
        for s in all_sett: by_pay[s.order_ref].append(s)
        matched = 0
        for o in all_orders:
            lst = by_pay.get(o.order_ref, [])
            if not lst:
                db.add(ReconException(type=ExceptionType.MISSING_SETTLEMENT, status=ExceptionStatus.OPEN, order_id=o.id, amount_at_risk_kobo=o.amount_kobo, evidence=f"Order {o.order_ref} {o.amount_kobo}k has no settlement")); continue
            exact = [s for s in lst if s.gross_kobo == o.amount_kobo]
            if exact:
                db.add(Match(tier=MatchTier.EXACT_REFERENCE, order_id=o.id, settlement_id=exact[0].id)); matched += 1
                for dup in exact[1:]:
                    db.add(ReconException(type=ExceptionType.DUPLICATE, status=ExceptionStatus.OPEN, order_id=o.id, settlement_id=dup.id, amount_at_risk_kobo=dup.gross_kobo, evidence=f"Duplicate settlement {dup.processor_ref} for {o.order_ref} {dup.gross_kobo}k"))
                for s in lst:
                    if s not in exact:
                        db.add(ReconException(type=ExceptionType.AMOUNT_MISMATCH, status=ExceptionStatus.OPEN, order_id=o.id, settlement_id=s.id, amount_at_risk_kobo=abs(o.amount_kobo - s.gross_kobo), evidence=f"Order {o.order_ref} {o.amount_kobo}k vs settlement {s.processor_ref} {s.gross_kobo}k"))
            else:
                for s in lst:
                    db.add(ReconException(type=ExceptionType.AMOUNT_MISMATCH, status=ExceptionStatus.OPEN, order_id=o.id, settlement_id=s.id, amount_at_risk_kobo=abs(o.amount_kobo - s.gross_kobo), evidence=f"Order {o.order_ref} {o.amount_kobo}k vs settlement {s.processor_ref} {s.gross_kobo}k"))
        db.commit()
        order_pays = {o.order_ref for o in all_orders}
        for s in all_sett:
            if s.order_ref not in order_pays:
                db.add(ReconException(type=ExceptionType.NEEDS_REVIEW, status=ExceptionStatus.OPEN, settlement_id=s.id, amount_at_risk_kobo=s.gross_kobo, evidence=f"Orphan settlement {s.processor_ref} for unknown {s.order_ref} {s.gross_kobo}k"))
        # Bank matches by PAY-xxxx (order_ref), NOT by SET-xxxx. Narration is "desc | ref:PAY-xxxx"
        sett_by_pay = {}
        for s in all_sett:
            if s.order_ref:
                sett_by_pay.setdefault(s.order_ref, s)
        for b in all_bank:
            narr = b.narration or ""
            # Extract ref after "ref:" if present, else search for any PAY-xxxx in narration
            ref_pay = None
            if "ref:" in narr:
                ref_pay = narr.split("ref:", 1)[1].strip().split()[0].strip()
            if not ref_pay:
                for pay in sett_by_pay:
                    if pay and pay in narr:
                        ref_pay = pay
                        break
            sett = sett_by_pay.get(ref_pay) if ref_pay else None
            if sett is None:
                db.add(ReconException(type=ExceptionType.ORPHAN_BANK_CREDIT, status=ExceptionStatus.OPEN, bank_txn_id=b.id, amount_at_risk_kobo=b.amount_kobo, evidence=f"Orphan bank {b.bank_ref} {b.amount_kobo}k :: {b.narration}"))
            elif sett.net_kobo != b.amount_kobo:
                db.add(ReconException(type=ExceptionType.FEE_DISCREPANCY, status=ExceptionStatus.OPEN, settlement_id=sett.id, bank_txn_id=b.id, amount_at_risk_kobo=abs(sett.net_kobo - b.amount_kobo), evidence=f"Bank {b.bank_ref} {b.amount_kobo}k vs settlement {sett.processor_ref} net {sett.net_kobo}k"))
        db.commit()
        exceptions = db.query(ReconException).all()
        return {"ok": True, "TOTAL": len(all_orders), "MATCHED": matched, "EXCEPTIONS": len(exceptions),
                "orders": len(all_orders), "settlements": len(all_sett), "bank": len(all_bank),
                "exceptions": [{"type": e.type.value, "evidence": e.evidence} for e in exceptions]}
    except Exception as ex:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Upload failed: {str(ex)[:500]}")
    finally:
        db.close()

@router.get("/api/upload/result")
def last_result():
    db = SessionLocal()
    try:
        total = db.query(Order).count(); matched = db.query(Match).count(); exc = db.query(ReconException).all()
        return {"TOTAL": total, "MATCHED": matched, "EXCEPTIONS": len(exc), "exceptions": [{"type": e.type.value, "evidence": e.evidence, "status": e.status.value} for e in exc]}
    finally: db.close()
