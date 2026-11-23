from datetime import datetime, timezone
from app.core.database import SessionLocal
from app.models.tables import ReconException, ExceptionStatus, AuditLog
db = SessionLocal()
# Resolve the DUPLICATE SET-2006 as example - real reason, real audit
e = db.query(ReconException).filter(ReconException.evidence.like("%SET-2006%")).first()
print("found:", e.id if e else None, e.evidence if e else "NOT FOUND")
if e:
    e.status = ExceptionStatus.RESOLVED
    e.resolved_at = datetime.now(timezone.utc)
    db.add(AuditLog(exception_id=e.id, action="resolved", actor="dsahmadmagaji@gmail.com", note="Duplicate confirmed with provider - SET-2006 is same payout as SET-2005, ignore second record."))
    db.commit()
    print("resolved exception", e.id)
print("open now:", db.query(ReconException).filter(ReconException.status == ExceptionStatus.OPEN).count())
print("resolved now:", db.query(ReconException).filter(ReconException.status == ExceptionStatus.RESOLVED).count())
print("audit rows:", db.query(AuditLog).count())
db.close()
