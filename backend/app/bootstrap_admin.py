# One-time bootstrap: creates FIRST Super Admin if users table is empty.
# Run once on Render Shell, then it refuses to run again.
import os, sys
from datetime import datetime, timezone
from passlib.context import CryptContext
from app.core.database import SessionLocal, engine
from app.models.tables import Base, User
Base.metadata.create_all(bind=engine)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
def main():
    email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    name = os.getenv("BOOTSTRAP_ADMIN_NAME", "Ahmad Magaji").strip()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
    if not email or not password:
        print("Missing BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD")
        sys.exit(1)
    if len(password) < 12:
        print("Password must be at least 12 characters")
        sys.exit(1)
    db = SessionLocal()
    try:
        count = db.query(User).count()
        if count > 0:
            print(f"Refusing: users table already has {count} user(s). Bootstrap only runs when empty.")
            return
        user = User(name=name, email=email, password_hash=pwd_context.hash(password), role="super_admin", status="active", created_at=datetime.now(timezone.utc), last_activity_at=None)
        db.add(user)
        db.commit()
        print(f"Created Super Admin: {email}")
    finally:
        db.close()
if __name__ == "__main__":
    main()
