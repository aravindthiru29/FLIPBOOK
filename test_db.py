#!/usr/bin/env python3
"""
Database connection test script
Run this locally to verify your database connection is working
"""
import os
import sys
from datetime import datetime

# Add current directory to path
sys.path.insert(0, os.path.dirname(__file__))

def test_database():
    """Test database connection"""
    from app import app, db, init_db
    
    print("=" * 60)
    print("DATABASE CONNECTION TEST")
    print("=" * 60)
    
    # Check environment
    print("\n[1] Environment Check")
    print(f"    POSTGRES_URL: {'SET' if os.environ.get('POSTGRES_URL') else 'NOT SET'}")
    print(f"    DATABASE_URL: {'SET' if os.environ.get('DATABASE_URL') else 'NOT SET'}")
    print(f"    VERCEL: {os.environ.get('VERCEL', 'Not in Vercel')}")
    
    # Check Flask config
    print("\n[2] Flask Configuration")
    db_uri = app.config.get('SQLALCHEMY_DATABASE_URI', 'NOT SET')
    if db_uri and len(db_uri) > 50:
        print(f"    Database URI: {db_uri[:50]}...")
    else:
        print(f"    Database URI: {db_uri}")
    
    # Test connection
    print("\n[3] Testing Connection")
    try:
        with app.app_context():
            # Try to connect
            connection = db.engine.connect()
            print("    ✓ Connection successful!")
            
            # Try to execute a simple query
            result = connection.execute(db.text("SELECT 1;"))
            print("    ✓ Query execution successful!")
            
            # Check tables
            print("\n[4] Database Tables")
            inspector = db.inspect(db.engine)
            tables = inspector.get_table_names()
            if tables:
                for table in tables:
                    print(f"    ✓ {table}")
            else:
                print("    No tables found (database is empty)")
            
            connection.close()
            
            # Try full initialization
            print("\n[5] Full Initialization")
            init_db()
            print("    ✓ Database initialization complete!")
            
            return True
            
    except Exception as e:
        print(f"    ✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == '__main__':
    success = test_database()
    print("\n" + "=" * 60)
    if success:
        print("✓ All tests passed! Database is properly configured.")
    else:
        print("✗ Tests failed. Check the errors above.")
    print("=" * 60)
    sys.exit(0 if success else 1)
