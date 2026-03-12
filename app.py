import os
import fitz  # PyMuPDF
import json
import uuid
import threading
from datetime import datetime
from flask import Flask, render_template, request, send_from_directory, jsonify, url_for, session, redirect
from functools import wraps
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename
app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-123')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')
# --- Configuration ---
database_url = os.environ.get('POSTGRES_URL')
if database_url:
    # Fix PostgreSQL URL format for newer psycopg2 versions
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)
    # Ensure SSL mode is set (required for Vercel)
    if '?' not in database_url:
        database_url += '?sslmode=require'
    elif 'sslmode' not in database_url:
        database_url += '&sslmode=require'
    
    app.config['SQLALCHEMY_DATABASE_URI'] = database_url
    print(f"Using PostgreSQL: {database_url[:50]}...")
    # Vercel-specific pool settings for PostgreSQL
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'pool_size': 1,
        'max_overflow': 1,
        'pool_recycle': 3600,
        'pool_pre_ping': True,
        'connect_args': {
            'connect_timeout': 15,
            'application_name': 'flipbook_app'
        }
    }
else:
    # We fallback to sqlite only if specifically running locally.
    print("WARNING: POSTGRES_URL not found. Using SQLite (Local Mode).")
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///flipbook.db'
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'connect_args': {'timeout': 30}
    }

# --- Vercel Compatibility ---
IS_VERCEL = os.environ.get('VERCEL') == '1'

# --- Paths & Directories ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

if IS_VERCEL:
    app.config['UPLOAD_FOLDER'] = '/tmp/uploads'
    app.config['PAGES_FOLDER'] = '/tmp/pages'
else:
    app.config['UPLOAD_FOLDER'] = os.path.join(BASE_DIR, 'uploads')
    app.config['PAGES_FOLDER'] = os.path.join(BASE_DIR, 'static', 'pages')

# Ensure directories exist
for folder in [app.config['UPLOAD_FOLDER'], app.config['PAGES_FOLDER']]:
    if not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB limit
db = SQLAlchemy(app)
# Flag to track if database has been initialized
_db_initialized = False
_db_error = None
# Initialize database tables
def init_db():
    global _db_initialized, _db_error
    if _db_initialized:
        return
    
    try:
        with app.app_context():
            print("Attempting database connection...")
            # Test connection
            connection = db.engine.connect()
            print("✓ Database connection successful")
            connection.close()
            # Create tables
            db.create_all()
            print("✓ Database tables created/verified")
            if not os.path.exists(app.config['UPLOAD_FOLDER']):
                os.makedirs(app.config['UPLOAD_FOLDER'])
                print(f"✓ Created uploads folder")
            if not os.path.exists(app.config['PAGES_FOLDER']):
                os.makedirs(app.config['PAGES_FOLDER'])
                print(f"✓ Created pages folder")
            _db_initialized = True
            print("✓ Database initialization complete")
    except Exception as e:
        _db_error = str(e)
        print(f"✗ Database initialization error: {e}")
        import traceback
        traceback.print_exc()
# Register before_request handler for Vercel compatibility
@app.before_request
def before_request():
    global _db_initialized, _db_error
    if not _db_initialized:
        try:
            with app.app_context():
                print("Attempting lazy database initialization...")              
                # Test connection
                connection = db.engine.connect()
                print("✓ Database connection successful")
                connection.close()
                # Create tables
                db.create_all()
                print("✓ Database tables created/verified")
                if not os.path.exists(app.config['UPLOAD_FOLDER']):
                    os.makedirs(app.config['UPLOAD_FOLDER'])
                if not os.path.exists(app.config['PAGES_FOLDER']):
                    os.makedirs(app.config['PAGES_FOLDER'])
                _db_initialized = True
                print("✓ Lazy initialization complete")
        except Exception as e:
            _db_error = str(e)
            print(f"✗ Lazy initialization error: {e}")
            import traceback
            traceback.print_exc()
# --- Auth Decorator ---
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('is_admin'):
            if request.is_json:
                return jsonify({'error': 'Admin access required'}), 403
            return redirect(url_for('admin_login'))
        return f(*args, **kwargs)
    return decorated_function

# --- Models ---
class Book(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    page_count = db.Column(db.Integer)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    notes = db.relationship('Note', backref='book', lazy=True, cascade="all, delete-orphan")
    highlights = db.relationship('Highlight', backref='book', lazy=True, cascade="all, delete-orphan")
class Note(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    book_id = db.Column(db.Integer, db.ForeignKey('book.id'), nullable=False)
    page_number = db.Column(db.Integer, nullable=False)
    content = db.Column(db.Text, nullable=False)
    x = db.Column(db.Float)  # Spatial coordinates
    y = db.Column(db.Float)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
class Highlight(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    book_id = db.Column(db.Integer, db.ForeignKey('book.id'), nullable=False)
    page_number = db.Column(db.Integer, nullable=False)
    coordinates = db.Column(db.JSON, nullable=False)  # JSON list of rects
    color = db.Column(db.String(50), default='yellow')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
# --- PDF Utilities ---
def get_pdf_metadata(filepath):
    with render_lock:
        doc = fitz.open(filepath)
        toc = doc.get_toc()
        page_count = doc.page_count
        doc.close()
    return page_count, toc
# Global lock for PDF operations (PyMuPDF is not thread-safe for concurrent writes)
render_lock = threading.Lock()

# Document cache to avoid repeated file opening
doc_cache = {}
DOC_CACHE_LIMIT = 5

def get_cached_doc(filepath):
    if filepath in doc_cache:
        return doc_cache[filepath]
    
    if len(doc_cache) >= DOC_CACHE_LIMIT:
        # Simple cache eviction: remove the first key
        oldest_key = next(iter(doc_cache))
        try:
            doc_cache[oldest_key].close()
        except:
            pass
        del doc_cache[oldest_key]
    
    doc = fitz.open(filepath)
    doc_cache[filepath] = doc
    return doc

def render_pdf_page(filepath, page_num, output_folder):
    """Render a PDF page with multiple fallback options for reliability"""
    with render_lock:
        try:
            if not os.path.exists(filepath):
                raise FileNotFoundError(f"PDF file not found: {filepath}")

            doc = get_cached_doc(filepath)
            page = doc.load_page(page_num)
            filename = f"page_{page_num}.jpg"
            dest_path = os.path.join(output_folder, filename)    
            
            if not os.path.exists(output_folder):
                os.makedirs(output_folder, exist_ok=True)    
            
            # Step 1: Standard quality (1.2x)
            try:
                pix = page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False)
                if pix and pix.n > 0:
                    pix.save(dest_path, "jpg", quality=80)
                    return filename
            except Exception as e1:
                print(f"Standard render failed for page {page_num}: {e1}")
            
            # Step 2: Fallback quality (1.0x)
            try:
                pix = page.get_pixmap(alpha=False)
                if pix and pix.n > 0:
                    pix.save(dest_path, "jpg", quality=70)
                    print(f"Fallback render (1.0x) succeeded for page {page_num}")
                    return filename
            except Exception as e2:
                print(f"Fallback render failing for page {page_num}: {e2}")
            
            raise ValueError(f"Could not render page {page_num} - possible memory limit or complex PDF structure.")
            
        except Exception as e:
            print(f"Critical error rendering page {page_num}: {str(e)}")
            # If it's a document error, clear it from cache so it can be re-opened
            if filepath in doc_cache:
                try:
                    doc_cache[filepath].close()
                except:
                    pass
                del doc_cache[filepath]
            raise e
def pre_render_book(filepath, book_id, page_count):
    """Background task to pre-render all pages with error handling"""
    output_folder = os.path.join(app.config['PAGES_FOLDER'], str(book_id))
    print(f"Starting background pre-rendering for book {book_id} in {output_folder}...")
    if not os.path.exists(output_folder):
        os.makedirs(output_folder, exist_ok=True)
    
    rendered_count = 0
    failed_pages = []
    
    for i in range(page_count):
        page_filename = f"page_{i}.jpg"
        page_path = os.path.join(output_folder, page_filename)        
        if not os.path.exists(page_path):
            try:
                with render_lock:
                    doc = get_cached_doc(filepath)
                    page = doc.load_page(i)
                    pix = page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False)
                    if pix.n > 0:
                        pix.save(page_path, "jpg", quality=80)
                        rendered_count += 1
                    else:
                        raise ValueError("Empty pixmap")
                # Small sleep to allow other request threads to grab the lock
                import time
                time.sleep(0.01)
            except Exception as e:
                print(f"Error pre-rendering page {i}: {str(e)}")
                failed_pages.append(i)
        else:
            rendered_count += 1
    
    print(f"Background pre-rendering complete for book {book_id}. Rendered: {rendered_count}/{page_count}")
    if failed_pages:
        print(f"Failed pages: {failed_pages}")
# --- Routes ---
@app.route('/health')
def health_check():
    result = {
        'status': 'unknown',
        'database': 'unknown',
        'initialized': _db_initialized,
        'db_error': _db_error,
        'postgres_url': 'configured' if os.environ.get('POSTGRES_URL') else 'missing'
    } 
    try:
        # Test database connection
        print("[Health Check] Testing database connection...")
        connection = db.engine.connect()
        result['status'] = 'healthy'
        result['database'] = 'connected'
        result['pool_info'] = f"Pool size: {db.engine.pool.size()}"
        connection.close()
        print("[Health Check] Database connection successful")
        return jsonify(result), 200
    except Exception as e:
        result['status'] = 'unhealthy'
        result['database'] = 'disconnected'
        result['error'] = str(e)
        result['error_type'] = type(e).__name__
        print(f"[Health Check] Database error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify(result), 503
@app.route('/')
def index():
    try:
        books = Book.query.order_by(Book.created_at.desc()).all()
        return render_template('index.html', books=books)
    except Exception as e:
        print(f"Index error: {str(e)}")
        return jsonify({'error': 'Database connection failed'}), 503

@app.route('/admin/login', methods=['GET', 'POST'])
def admin_login():
    if request.method == 'POST':
        password = request.form.get('password')
        if password == ADMIN_PASSWORD:
            session['is_admin'] = True
            return redirect(url_for('admin_dashboard'))
        return render_template('admin_login.html', error="Invalid password")
    return render_template('admin_login.html')

@app.route('/admin/logout')
def admin_logout():
    session.pop('is_admin', None)
    return redirect(url_for('index'))

@app.route('/admin')
@admin_required
def admin_dashboard():
    books = Book.query.order_by(Book.created_at.desc()).all()
    return render_template('admin_dashboard.html', books=books)
@app.route('/upload', methods=['POST'])
def upload_file():
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file part'}), 400
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        if file and file.filename.lower().endswith('.pdf'):
            # Ensure upload folder exists
            if not os.path.exists(app.config['UPLOAD_FOLDER']):
                os.makedirs(app.config['UPLOAD_FOLDER'])
            filename = secure_filename(file.filename)
            # Unique folder for each book to avoid collisions
            unique_id = str(uuid.uuid4())[:8]
            save_name = f"{unique_id}_{filename}"
            # Ensure absolute path for saving the uploaded PDF
            file_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], save_name))
            file.save(file_path)
            print(f"Uploaded PDF saved to: {file_path}")
            # Get metadata and add print statements
            print(f"Opening PDF for metadata extraction: {file_path}")
            page_count, toc = get_pdf_metadata(file_path)
            print(f"PDF opened successfully. Total pages: {page_count}")
            new_book = Book(title=filename, filename=save_name, page_count=page_count)
            db.session.add(new_book)
            db.session.commit()
            # Start background pre-rendering
            thread = threading.Thread(target=pre_render_book, args=(file_path, new_book.id, page_count))
            thread.daemon = True
            thread.start()            
            return jsonify({
                'success': True,
                'book_id': new_book.id,
                'title': new_book.title,
                'page_count': new_book.page_count,
                'redirect': url_for('view_book', book_id=new_book.id)
            })
        return jsonify({'error': 'Invalid file type'}), 400
    except Exception as e:
        print(f"Upload error: {str(e)}")
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500
@app.route('/book/<int:book_id>')
def view_book(book_id):
    book = Book.query.get_or_404(book_id)
    return render_template('flipbook.html', book_data=book)
@app.route('/api/book/<int:book_id>/page/<int:page_num>')
def get_page(book_id, page_num):
    book = Book.query.get_or_404(book_id)
    file_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], book.filename))
    
    # Critical: Check if the source PDF still exists (important for Vercel/Temporary storage)
    if not os.path.exists(file_path):
        print(f"CRITICAL: PDF source missing at {file_path}")
        return jsonify({
            'error': 'PDF file not found on the server.',
            'details': 'Uploaded files are only stored temporarily. You may need to delete and re-upload this book.',
            'is_storage_issue': True
        }), 404

    # Check if page is already rendered
    book_page_folder = os.path.join(app.config['PAGES_FOLDER'], str(book_id))
    page_filename = f"page_{page_num}.jpg"
    page_path = os.path.join(book_page_folder, page_filename)    
    
    # Validate page number
    if page_num < 0 or page_num >= book.page_count:
        return jsonify({'error': 'Page number out of range'}), 404

    # If the file exists but is 0 bytes, it's a failed previous render - delete it to force a retry
    if os.path.exists(page_path) and os.path.getsize(page_path) == 0:
        try:
            os.remove(page_path)
        except:
            pass

    if not os.path.exists(page_path):
        print(f"Live rendering page {page_num} for book {book_id}...")
        try:
            render_pdf_page(file_path, page_num, book_page_folder)
        except Exception as e:
            return jsonify({
                'error': f'Failed to render page {page_num}.',
                'details': str(e)
            }), 500    
            
    # Final check for successfully rendered file
    if os.path.exists(page_path) and os.path.getsize(page_path) > 0:
        return send_from_directory(book_page_folder, page_filename)
        
    return jsonify({'error': f'Could not render page {page_num}'}), 500
@app.route('/api/book/<int:book_id>/toc')
def get_toc(book_id):
    book = Book.query.get_or_404(book_id)
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], book.filename)
    _, toc = get_pdf_metadata(file_path)
    return jsonify(toc)
# Notes API
@app.route('/api/book/<int:book_id>/notes', methods=['GET', 'POST'])
def handle_notes(book_id):
    try:
        if request.method == 'POST':
            data = request.json
            if not data or 'page_number' not in data or 'content' not in data:
                return jsonify({'error': 'Missing required fields'}), 400
            
            new_note = Note(
                book_id=book_id,
                page_number=data['page_number'],
                content=data['content'],
                x=data.get('x'),
                y=data.get('y')
            )
            db.session.add(new_note)
            db.session.commit()
            return jsonify({'id': new_note.id, 'success': True})
        notes = Note.query.filter_by(book_id=book_id).all()
        return jsonify([{
            'id': n.id,
            'page_number': n.page_number,
            'content': n.content,
            'x': n.x,
            'y': n.y
        } for n in notes])
    except Exception as e:
        db.session.rollback()
        print(f"Notes API error: {str(e)}")
        return jsonify({'error': f'Notes operation failed: {str(e)}'}), 500

# Highlights API
@app.route('/api/book/<int:book_id>/highlights', methods=['GET', 'POST'])
def handle_highlights(book_id):
    try:
        if request.method == 'POST':
            data = request.json
            if not data or 'page_number' not in data or 'coordinates' not in data:
                return jsonify({'error': 'Missing required fields'}), 400
            
            new_highlight = Highlight(
                book_id=book_id,
                page_number=data['page_number'],
                coordinates=data['coordinates'],
                color=data.get('color', 'yellow')
            )
            db.session.add(new_highlight)
            db.session.commit()
            return jsonify({'id': new_highlight.id, 'success': True})
        highlights = Highlight.query.filter_by(book_id=book_id).all()
        return jsonify([{
            'id': h.id,
            'page_number': h.page_number,
            'coordinates': h.coordinates,
            'color': h.color
        } for h in highlights])
    except Exception as e:
        db.session.rollback()
        print(f"Highlights API error: {str(e)}")
        return jsonify({'error': f'Highlights operation failed: {str(e)}'}), 500
@app.route('/api/book/<int:book_id>/delete', methods=['DELETE'])
def delete_book(book_id):
    book = Book.query.get_or_404(book_id)
    # Remove files
    try:
        # PDF file
        pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], book.filename)
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
        # Pages directory
        pages_dir = os.path.join(app.config['PAGES_FOLDER'], str(book_id))
        if os.path.exists(pages_dir):
            import shutil
            shutil.rmtree(pages_dir)
    except Exception as e:
        print(f"Error deleting files: {e}")
    # Remove from DB
    db.session.delete(book)
    db.session.commit()
    return jsonify({'success': True})
@app.route('/api/book/<int:book_id>', methods=['PUT'])
def update_book(book_id):
    try:
        book = Book.query.get_or_404(book_id)
        data = request.json
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        if 'title' in data:
            book.title = data['title']
        db.session.commit()
        return jsonify({'success': True, 'title': book.title})
    except Exception as e:
        db.session.rollback()
        print(f"Update book error: {str(e)}")
        return jsonify({'error': f'Update failed: {str(e)}'}), 500
@app.route('/api/note/<int:note_id>', methods=['DELETE'])
@admin_required
def delete_note(note_id):
    try:
        note = Note.query.get_or_404(note_id)
        db.session.delete(note)
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        print(f"Delete note error: {str(e)}")
        return jsonify({'error': f'Delete failed: {str(e)}'}), 500
@app.route('/api/highlight/<int:highlight_id>', methods=['DELETE'])
@admin_required
def delete_highlight(highlight_id):
    try:
        highlight = Highlight.query.get_or_404(highlight_id)
        db.session.delete(highlight)
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        print(f"Delete highlight error: {str(e)}")
        return jsonify({'error': f'Delete failed: {str(e)}'}), 500
if __name__ == '__main__':
    app.run(debug=True)