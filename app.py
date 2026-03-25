import os
import fitz
import uuid
import threading
import secrets
import time
import shutil
import traceback
from io import BytesIO
from datetime import datetime
from flask import Flask, render_template, request, send_from_directory, send_file, jsonify, url_for, session, redirect, abort
from functools import wraps
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import inspect, text

app = Flask(__name__)

app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-123')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'bookbuddyadmin@123')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

database_url = os.environ.get('POSTGRES_URL')
if database_url:
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)
    if '?' not in database_url:
        database_url += '?sslmode=require'
    elif 'sslmode' not in database_url:
        database_url += '&sslmode=require'
    
    app.config['SQLALCHEMY_DATABASE_URI'] = database_url
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
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///flipbook.db'
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'connect_args': {'timeout': 30}
    }

IS_VERCEL = os.environ.get('VERCEL') == '1'
app.config['SESSION_COOKIE_SECURE'] = IS_VERCEL or os.environ.get('FLASK_ENV') == 'production'

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

if IS_VERCEL:
    app.config['UPLOAD_FOLDER'] = '/tmp/uploads'
    app.config['PAGES_FOLDER'] = '/tmp/pages'
else:
    app.config['UPLOAD_FOLDER'] = os.path.join(BASE_DIR, 'uploads')
    app.config['PAGES_FOLDER'] = os.path.join(BASE_DIR, 'static', 'pages')

for folder in [app.config['UPLOAD_FOLDER'], app.config['PAGES_FOLDER']]:
    if not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024
db = SQLAlchemy(app)

_db_initialized = False
_db_error = None

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    upload_limit = db.Column(db.Integer, default=3, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    books = db.relationship('Book', backref='owner', lazy=True)

class Book(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    page_count = db.Column(db.Integer)
    pdf_data = db.Column(db.LargeBinary)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    notes = db.relationship('Note', backref='book', lazy=True, cascade="all, delete-orphan")
    highlights = db.relationship('Highlight', backref='book', lazy=True, cascade="all, delete-orphan")

class ShareToken(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(64), unique=True, nullable=False, index=True)
    book_id = db.Column(db.Integer, db.ForeignKey('book.id'), nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    book = db.relationship('Book', backref='share_tokens')
    created_by = db.relationship('User')

class Note(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    book_id = db.Column(db.Integer, db.ForeignKey('book.id'), nullable=False)
    page_number = db.Column(db.Integer, nullable=False)
    content = db.Column(db.Text, nullable=False)
    x = db.Column(db.Float)
    y = db.Column(db.Float)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Highlight(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    book_id = db.Column(db.Integer, db.ForeignKey('book.id'), nullable=False)
    page_number = db.Column(db.Integer, nullable=False)
    coordinates = db.Column(db.JSON, nullable=False)
    color = db.Column(db.String(50), default='yellow')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

def ensure_db_updates():
    inspector = inspect(db.engine)
    book_cols = {column['name'] for column in inspector.get_columns('book')}
    user_cols = {column['name'] for column in inspector.get_columns('user')}
    
    with db.engine.begin() as connection:
        if 'pdf_data' not in book_cols:
            col_type = 'BYTEA' if db.engine.dialect.name == 'postgresql' else 'BLOB'
            connection.execute(text(f'ALTER TABLE book ADD COLUMN pdf_data {col_type}'))
        if 'owner_id' not in book_cols:
            connection.execute(text('ALTER TABLE book ADD COLUMN owner_id INTEGER'))
        if 'upload_limit' not in user_cols:
            table_name = '"user"' if db.engine.dialect.name == 'postgresql' else 'user'
            connection.execute(text(f'ALTER TABLE {table_name} ADD COLUMN upload_limit INTEGER DEFAULT 3 NOT NULL'))

def init_db():
    global _db_initialized, _db_error
    if _db_initialized:
        return
    try:
        with app.app_context():
            db.create_all()
            ensure_db_updates()
            if not os.path.exists(app.config['UPLOAD_FOLDER']):
                os.makedirs(app.config['UPLOAD_FOLDER'])
            if not os.path.exists(app.config['PAGES_FOLDER']):
                os.makedirs(app.config['PAGES_FOLDER'])
            _db_initialized = True
    except Exception as e:
        _db_error = str(e)
        traceback.print_exc()

@app.before_request
def before_request():
    global _db_initialized
    if not _db_initialized:
        init_db()

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('is_admin'):
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({'error': 'Admin access required'}), 403
            return redirect(url_for('admin_login'))
        return f(*args, **kwargs)
    return decorated_function

def get_current_user():
    user_id = session.get('user_id')
    if not user_id:
        return None
    return db.session.get(User, user_id)

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not get_current_user() and not session.get('is_admin'):
            if request.path.startswith('/api/') or request.path == '/upload':
                return jsonify({'error': 'Login required'}), 401
            return redirect(url_for('login', next=request.path))
        return f(*args, **kwargs)
    return decorated_function

def grant_shared_book_access(book_id):
    shared_ids = set(session.get('shared_book_ids', []))
    shared_ids.add(int(book_id))
    session['shared_book_ids'] = sorted(shared_ids)
    session.modified = True

def get_shared_book_ids():
    shared_ids = session.get('shared_book_ids', [])
    valid_ids = []
    for value in shared_ids:
        try:
            valid_ids.append(int(value))
        except (TypeError, ValueError):
            continue
    return valid_ids

def can_access_book(book):
    current_user = get_current_user()
    if session.get('is_admin'):
        return True
    if current_user and book.owner_id == current_user.id:
        return True
    return book.id in get_shared_book_ids()

def require_book_access(book):
    if not can_access_book(book):
        abort(403)

def can_manage_book(book):
    current_user = get_current_user()
    if session.get('is_admin'):
        return True
    return bool(current_user and book.owner_id == current_user.id)

render_lock = threading.Lock()
doc_cache = {}
DOC_CACHE_LIMIT = 1 if IS_VERCEL else 3

def get_pdf_metadata(filepath=None, pdf_bytes=None):
    with render_lock:
        doc = fitz.open(stream=pdf_bytes, filetype='pdf') if pdf_bytes else fitz.open(filepath)
        toc = doc.get_toc()
        page_count = doc.page_count
        doc.close()
    return page_count, toc

def ensure_book_pdf_file(book):
    file_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], book.filename))
    if os.path.exists(file_path):
        return file_path
    if not book.pdf_data:
        return None
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, 'wb') as pdf_file:
        pdf_file.write(book.pdf_data)
    return file_path

def get_cached_doc(cache_key, filepath=None, pdf_bytes=None):
    if cache_key in doc_cache:
        try:
            doc_cache[cache_key].page_count
            return doc_cache[cache_key]
        except Exception:
            doc_cache.pop(cache_key, None)

    if len(doc_cache) >= DOC_CACHE_LIMIT:
        oldest_key = next(iter(doc_cache))
        try:
            doc_cache[oldest_key].close()
        except Exception:
            pass
        del doc_cache[oldest_key]

    doc = fitz.open(stream=pdf_bytes, filetype='pdf') if pdf_bytes else fitz.open(filepath)
    doc_cache[cache_key] = doc
    return doc

def render_pdf_page(page_num, output_folder, filepath=None, pdf_bytes=None, cache_key=None):
    with render_lock:
        dest_filename = f"page_{page_num}.jpg"
        dest_path = os.path.join(output_folder, dest_filename)
        
        if not os.path.exists(output_folder):
            os.makedirs(output_folder, exist_ok=True)

        try:
            doc = get_cached_doc(
                cache_key or filepath or f"bytes:{len(pdf_bytes) if pdf_bytes else 0}",
                filepath=filepath,
                pdf_bytes=pdf_bytes
            )
            page = doc.load_page(page_num)
            scale = 1.0 if IS_VERCEL else 1.2
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
            if pix and pix.n > 0:
                pix.save(dest_path, "jpg", quality=75)
                return dest_filename
        except Exception:
            doc_cache.pop(cache_key or filepath or f"bytes:{len(pdf_bytes) if pdf_bytes else 0}", None)

        try:
            doc = fitz.open(stream=pdf_bytes, filetype='pdf') if pdf_bytes else fitz.open(filepath)
            page = doc.load_page(page_num)
            pix = page.get_pixmap(alpha=False, colorspace=fitz.csRGB)
            if pix and pix.n > 0:
                pix.save(dest_path, "jpg", quality=70)
                doc.close()
                return dest_filename
            doc.close()
        except Exception:
            pass
        
        if os.path.exists(dest_path):
            try: os.remove(dest_path)
            except: pass
        raise ValueError(f"Failed to render page {page_num} after multiple attempts.")

def pre_render_book(filepath, book_id, page_count):
    if IS_VERCEL:
        return
    output_folder = os.path.join(app.config['PAGES_FOLDER'], str(book_id))
    if not os.path.exists(output_folder):
        os.makedirs(output_folder, exist_ok=True)
    for i in range(page_count):
        time.sleep(0.05)
        try:
            render_pdf_page(i, output_folder, filepath=filepath, cache_key=filepath)
        except Exception:
            pass

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
        connection = db.engine.connect()
        result['status'] = 'healthy'
        result['database'] = 'connected'
        result['pool_info'] = f"Pool size: {db.engine.pool.size()}"
        connection.close()
        return jsonify(result), 200
    except Exception as e:
        result['status'] = 'unhealthy'
        result['database'] = 'disconnected'
        result['error'] = str(e)
        result['error_type'] = type(e).__name__
        return jsonify(result), 503

# --- Replace your existing index, register, and login routes in app.py with these ---

@app.route('/')
def index():
    try:
        # If the user is already logged in, send them straight to their dashboard
        current_user = get_current_user()
        if session.get('is_admin') or current_user:
            return redirect(url_for('dashboard'))
            
        # If not logged in, show the clean marketing landing page
        return render_template('index.html', current_user=None)
    except Exception:
        return jsonify({'error': 'Database connection failed'}), 503

# NEW ROUTE: The User Dashboard / Library
@app.route('/dashboard')
@login_required
def dashboard():
    current_user = get_current_user()
    if session.get('is_admin'):
        books = Book.query.order_by(Book.created_at.desc()).all()
    elif current_user:
        books = Book.query.filter_by(owner_id=current_user.id).order_by(Book.created_at.desc()).all()
    else:
        books = []
    return render_template('dashboard.html', books=books, current_user=current_user)

@app.route('/register', methods=['GET', 'POST'])
def register():
    if session.get('is_admin') or get_current_user():
        return redirect(url_for('dashboard')) # Redirect to dashboard instead of index

    if request.method == 'POST':
        username = (request.form.get('username') or '').strip()
        password = request.form.get('password') or ''
        confirm_password = request.form.get('confirm_password') or ''

        if len(username) < 3:
            return render_template('register.html', error='Username must be at least 3 characters long.')
        if len(password) < 6:
            return render_template('register.html', error='Password must be at least 6 characters long.')
        if password != confirm_password:
            return render_template('register.html', error='Passwords do not match.')
        if User.query.filter_by(username=username).first():
            return render_template('register.html', error='That username is already taken.')

        user = User(username=username, password_hash=generate_password_hash(password), upload_limit=3)
        db.session.add(user)
        db.session.commit()
        session['user_id'] = user.id
        return redirect(url_for('dashboard')) # Redirect to dashboard

    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if session.get('is_admin') or get_current_user():
        return redirect(url_for('dashboard')) # Redirect to dashboard

    if request.method == 'POST':
        username = (request.form.get('username') or '').strip()
        password = request.form.get('password') or ''
        user = User.query.filter_by(username=username).first()

        if user and check_password_hash(user.password_hash, password):
            session.clear()
            session['user_id'] = user.id
            next_url = request.args.get('next') or request.form.get('next')
            return redirect(next_url or url_for('dashboard')) # Redirect to dashboard

        return render_template('login.html', error='Invalid username or password.', next_url=request.args.get('next'))

    return render_template('login.html', next_url=request.args.get('next'))




@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('index'))

@app.route('/admin/login', methods=['GET', 'POST'])
def admin_login():
    if request.method == 'POST':
        password = request.form.get('password')
        if password == ADMIN_PASSWORD:
            session.clear()
            session['is_admin'] = True
            return redirect(url_for('admin_dashboard'))
        return render_template('admin_login.html', error="Invalid password")
    return render_template('admin_login.html')

@app.route('/admin/logout')
def admin_logout():
    session.clear()
    return redirect(url_for('index'))

@app.route('/admin')
@admin_required
def admin_dashboard():
    books = Book.query.order_by(Book.created_at.desc()).all()
    users = User.query.all()
    return render_template('admin_dashboard.html', books=books, users=users)

@app.route('/admin/update_limit', methods=['POST'])
@admin_required
def update_user_limit():
    user_id = request.form.get('user_id')
    new_limit = request.form.get('limit')
    if user_id and new_limit:
        user = User.query.get(user_id)
        if user:
            user.upload_limit = int(new_limit)
            db.session.commit()
    return redirect(url_for('admin_dashboard'))

@app.route('/upload', methods=['POST'])
@login_required
def upload_file():
    try:
        current_user = get_current_user()
        if current_user and not session.get('is_admin'):
            book_count = Book.query.filter_by(owner_id=current_user.id).count()
            if book_count >= current_user.upload_limit:
                return jsonify({'error': f'Upload limit reached. Maximum {current_user.upload_limit} files allowed.'}), 403

        if 'file' not in request.files:
            return jsonify({'error': 'No file part'}), 400
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        if file and file.filename.lower().endswith('.pdf'):
            if not os.path.exists(app.config['UPLOAD_FOLDER']):
                os.makedirs(app.config['UPLOAD_FOLDER'])
            
            file_bytes = file.read()
            if not file_bytes:
                return jsonify({'error': 'Uploaded file is empty'}), 400
            
            filename = secure_filename(file.filename)
            unique_id = str(uuid.uuid4())[:8]
            save_name = f"{unique_id}_{filename}"
            file_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], save_name))
            
            with open(file_path, 'wb') as saved_file:
                saved_file.write(file_bytes)
            
            page_count, toc = get_pdf_metadata(pdf_bytes=file_bytes)
            
            new_book = Book(
                title=filename,
                filename=save_name,
                page_count=page_count,
                pdf_data=file_bytes,
                owner_id=current_user.id if current_user else None
            )
            db.session.add(new_book)
            db.session.commit()
            
            if not IS_VERCEL:
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
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500

@app.route('/book/<int:book_id>')
def view_book(book_id):
    book = Book.query.get_or_404(book_id)
    require_book_access(book)
    return render_template(
        'flipbook.html',
        book_data=book,
        can_annotate=can_manage_book(book)
    )

@app.route('/shared/<string:token>')
def open_shared_book(token):
    share_token = ShareToken.query.filter_by(token=token, is_active=True).first_or_404()
    grant_shared_book_access(share_token.book_id)
    return redirect(url_for('view_book', book_id=share_token.book_id))

@app.route('/api/book/<int:book_id>/share-links', methods=['POST'])
@login_required
def create_share_link(book_id):
    book = Book.query.get_or_404(book_id)
    if not can_manage_book(book):
        return jsonify({'error': 'Book access required'}), 403

    current_user = get_current_user()
    token = secrets.token_urlsafe(24)
    share_token = ShareToken(
        token=token,
        book_id=book.id,
        created_by_id=current_user.id if current_user else None
    )
    db.session.add(share_token)
    db.session.commit()

    return jsonify({
        'success': True,
        'share_url': url_for('open_shared_book', token=token, _external=True)
    })

@app.route('/api/book/<int:book_id>/pdf')
def get_book_pdf(book_id):
    book = Book.query.get_or_404(book_id)
    require_book_access(book)
    if book.pdf_data:
        response = send_file(
            BytesIO(book.pdf_data),
            mimetype='application/pdf',
            as_attachment=False,
            download_name=book.title,
            conditional=True,
            etag=False,
            max_age=0
        )
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    file_path = ensure_book_pdf_file(book)
    if not file_path:
        return jsonify({'error': 'PDF file missing'}), 404
    response = send_file(
        file_path,
        mimetype='application/pdf',
        as_attachment=False,
        download_name=book.title,
        conditional=True,
        etag=False,
        max_age=0
    )
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response

@app.route('/api/book/<int:book_id>/page/<int:page_num>')
def get_page(book_id, page_num):
    book = Book.query.get_or_404(book_id)
    require_book_access(book)
    pdf_bytes = book.pdf_data
    file_path = None if pdf_bytes else ensure_book_pdf_file(book)
    
    if not pdf_bytes and (not file_path or not os.path.exists(file_path)):
        return jsonify({
            'error': 'PDF file not found on the server.',
            'details': 'The original upload is not available in persistent storage. Re-upload this book to restore it.',
            'is_storage_issue': True
        }), 404

    book_page_folder = os.path.join(app.config['PAGES_FOLDER'], str(book_id))
    page_filename = f"page_{page_num}.jpg"
    page_path = os.path.join(book_page_folder, page_filename)    
    
    if page_num < 0 or page_num >= book.page_count:
        return jsonify({'error': 'Page number out of range'}), 404

    if os.path.exists(page_path) and os.path.getsize(page_path) == 0:
        try:
            os.remove(page_path)
        except:
            pass

    if not os.path.exists(page_path):
        try:
            render_pdf_page(
                page_num,
                book_page_folder,
                filepath=file_path,
                pdf_bytes=pdf_bytes,
                cache_key=f"book:{book_id}"
            )
        except Exception as e:
            return jsonify({
                'error': f'Failed to render page {page_num}.',
                'details': str(e)
            }), 500    
            
    if os.path.exists(page_path) and os.path.getsize(page_path) > 0:
        return send_from_directory(book_page_folder, page_filename)
        
    return jsonify({'error': f'Could not render page {page_num}'}), 500

@app.route('/api/book/<int:book_id>/toc')
def get_toc(book_id):
    book = Book.query.get_or_404(book_id)
    require_book_access(book)
    if book.pdf_data:
        _, toc = get_pdf_metadata(pdf_bytes=book.pdf_data)
        return jsonify(toc)

    file_path = ensure_book_pdf_file(book)
    if not file_path:
        return jsonify({'error': 'PDF file missing'}), 404
    _, toc = get_pdf_metadata(file_path)
    return jsonify(toc)

@app.route('/api/book/<int:book_id>/notes', methods=['GET', 'POST'])
def handle_notes(book_id):
    try:
        book = Book.query.get_or_404(book_id)
        require_book_access(book)
        if request.method == 'POST':
            if not can_manage_book(book):
                return jsonify({'error': 'Book access required'}), 403
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
        return jsonify({'error': f'Notes operation failed: {str(e)}'}), 500

@app.route('/api/book/<int:book_id>/highlights', methods=['GET', 'POST'])
def handle_highlights(book_id):
    try:
        book = Book.query.get_or_404(book_id)
        require_book_access(book)
        if request.method == 'POST':
            if not can_manage_book(book):
                return jsonify({'error': 'Book access required'}), 403
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
        return jsonify({'error': f'Highlights operation failed: {str(e)}'}), 500

@app.route('/api/book/<int:book_id>/delete', methods=['DELETE'])
def delete_book(book_id):
    book = Book.query.get_or_404(book_id)
    if not can_manage_book(book):
        return jsonify({'error': 'Book access required'}), 403
    try:
        pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], book.filename)
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
        pages_dir = os.path.join(app.config['PAGES_FOLDER'], str(book_id))
        if os.path.exists(pages_dir):
            shutil.rmtree(pages_dir)
    except Exception:
        pass
    db.session.delete(book)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/book/<int:book_id>', methods=['PUT'])
def update_book(book_id):
    try:
        book = Book.query.get_or_404(book_id)
        if not can_manage_book(book):
            return jsonify({'error': 'Book access required'}), 403
        data = request.json
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        if 'title' in data:
            book.title = data['title']
        db.session.commit()
        return jsonify({'success': True, 'title': book.title})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': f'Update failed: {str(e)}'}), 500

@app.route('/api/note/<int:note_id>', methods=['DELETE'])
def delete_note(note_id):
    try:
        note = Note.query.get_or_404(note_id)
        if not can_manage_book(note.book):
            return jsonify({'error': 'Book access required'}), 403
        db.session.delete(note)
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': f'Delete failed: {str(e)}'}), 500

@app.route('/api/highlight/<int:highlight_id>', methods=['DELETE'])
def delete_highlight(highlight_id):
    try:
        highlight = Highlight.query.get_or_404(highlight_id)
        if not can_manage_book(highlight.book):
            return jsonify({'error': 'Book access required'}), 403
        db.session.delete(highlight)
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': f'Delete failed: {str(e)}'}), 500

if __name__ == '__main__':
    app.run(debug=True)