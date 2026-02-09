import os
import fitz  # PyMuPDF
import json
import uuid
import io
import requests
import vercel_blob
from datetime import datetime
from flask import Flask, render_template, request, send_file, jsonify, url_for
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = Flask(__name__)

# --- Configuration ---
# Use POSTGRES_URL if available
# FALLBACK: Only fallback to sqlite if explicitly testing locally
if os.environ.get('POSTGRES_URL'):
    app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('POSTGRES_URL')
else:
    # If we are on Vercel (production), we MUST use Postgres.
    # We fallback to sqlite only if specifically running locally.
    print("WARNING: POSTGRES_URL not found. Using SQLite (Local Mode).")
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///flipbook.db'

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB limit
# Vercel Blob Token
app.config['BLOB_READ_WRITE_TOKEN'] = os.environ.get('BLOB_READ_WRITE_TOKEN')

db = SQLAlchemy(app)

# --- Models ---
class Book(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    # Store the Blob URL instead of a local filename
    pdf_url = db.Column(db.Text, nullable=False) 
    page_count = db.Column(db.Integer)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    notes = db.relationship('Note', backref='book', lazy=True, cascade="all, delete-orphan")
    highlights = db.relationship('Highlight', backref='book', lazy=True, cascade="all, delete-orphan")

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

# --- Helper Functions ---
def get_pdf_from_blob(pdf_url, book_id):
    """
    Download PDF from Blob storage to a temporary file for processing.
    Returns path to temp file.
    """
    tmp_path = f"/tmp/book_{book_id}.pdf"
    
    # Check if already cached in /tmp (Vercel sometimes persists /tmp)
    if os.path.exists(tmp_path):
        return tmp_path
        
    print(f"Downloading PDF from Blob: {pdf_url}")
    response = requests.get(pdf_url)
    if response.status_code == 200:
        with open(tmp_path, 'wb') as f:
            f.write(response.content)
        return tmp_path
    else:
        raise Exception(f"Failed to download PDF from Blob: {response.status_code}")

def get_pdf_metadata(filepath):
    doc = fitz.open(filepath)
    toc = doc.get_toc()
    page_count = doc.page_count
    doc.close()
    return page_count, toc

# --- Routes ---
@app.route('/debug-env')
def debug_env():
    """Check if Vercel environment variables are set"""
    return jsonify({
        'POSTGRES_URL_SET': bool(os.environ.get('POSTGRES_URL')),
        'BLOB_READ_WRITE_TOKEN_SET': bool(os.environ.get('BLOB_READ_WRITE_TOKEN')),
        'ENV_VARS_KEYS': list(os.environ.keys()) 
    })

@app.route('/')
def index():
    # Only create tables if they don't exist (safe for Postgres)
    with app.app_context():
        try:
            db.create_all()
        except:
            pass # DB might already be created
    try:
        books = Book.query.order_by(Book.created_at.desc()).all()
        return render_template('index.html', books=books)
    except Exception as e:
        return jsonify({'error': 'Database Connection Failed', 'details': str(e)}), 500

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file and file.filename.lower().endswith('.pdf'):
        filename = secure_filename(file.filename)
        
        try:
            # 1. Upload to Vercel Blob
            print("Uploading to Vercel Blob...")
            # Use vercel_blob library or fallback to requests if not available
            # Note: For this to work, BLOB_READ_WRITE_TOKEN must be set in env
            blob_token = app.config.get('BLOB_READ_WRITE_TOKEN')
            if not blob_token:
                return jsonify({'error': 'BLOB_READ_WRITE_TOKEN not set'}), 500
                
            blob_resp = vercel_blob.put(
                filename, 
                file.read(), 
                options={'access': 'public', 'token': blob_token}
            )
            pdf_url = blob_resp['url']
            print(f"Uploaded to Blob: {pdf_url}")

            # 2. Get Metadata (Download to tmp first)
            # We need to calculate page count.
            unique_id = str(uuid.uuid4())[:8]
            tmp_path = f"/tmp/{unique_id}_{filename}"
            
            response = requests.get(pdf_url)
            with open(tmp_path, 'wb') as f:
                f.write(response.content)
            
            page_count, toc = get_pdf_metadata(tmp_path)
            
            # 3. Save to DB
            new_book = Book(title=filename, pdf_url=pdf_url, page_count=page_count)
            db.session.add(new_book)
            db.session.commit()
            
            # Clean up tmp file
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            
            return jsonify({
                'success': True,
                'book_id': new_book.id,
                'title': new_book.title,
                'page_count': new_book.page_count,
                'redirect': url_for('view_book', book_id=new_book.id)
            })

        except Exception as e:
            print(f"Upload failed: {e}")
            import traceback
            return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500
    
    return jsonify({'error': 'Invalid file type'}), 400

@app.route('/book/<int:book_id>')
def view_book(book_id):
    book = Book.query.get_or_404(book_id)
    return render_template('flipbook.html', book_data=book)

@app.route('/api/book/<int:book_id>/page/<int:page_num>')
def get_page(book_id, page_num):
    book = Book.query.get_or_404(book_id)
    
    # On-demand rendering (Serverless Friendly)
    try:
        # 1. Get PDF path (cached in /tmp or downloaded)
        pdf_path = get_pdf_from_blob(book.pdf_url, book_id)
        
        # 2. Open PDF and render page
        doc = fitz.open(pdf_path)
        
        if page_num < 0 or page_num >= book.page_count:
            return jsonify({'error': 'Page number out of range'}), 404
            
        page = doc.load_page(page_num)
        
        # Render high quality
        zoom = 2.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        
        # 3. Return image directly
        img_io = io.BytesIO(pix.tobytes())
        img_io.seek(0)
        
        doc.close()
        return send_file(img_io, mimetype='image/jpeg')

    except Exception as e:
        print(f"Error rendering page {page_num}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/book/<int:book_id>/toc')
def get_toc(book_id):
    book = Book.query.get_or_404(book_id)
    try:
        pdf_path = get_pdf_from_blob(book.pdf_url, book_id)
        _, toc = get_pdf_metadata(pdf_path)
        return jsonify(toc)
    except Exception as e:
        return jsonify([])

# Notes API
@app.route('/api/book/<int:book_id>/notes', methods=['GET', 'POST'])
def handle_notes(book_id):
    if request.method == 'POST':
        data = request.json
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

# Highlights API
@app.route('/api/book/<int:book_id>/highlights', methods=['GET', 'POST'])
def handle_highlights(book_id):
    if request.method == 'POST':
        data = request.json
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

@app.route('/api/book/<int:book_id>/delete', methods=['DELETE'])
def delete_book(book_id):
    book = Book.query.get_or_404(book_id)
    db.session.delete(book)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/book/<int:book_id>', methods=['PUT'])
def update_book(book_id):
    book = Book.query.get_or_404(book_id)
    data = request.json
    if 'title' in data:
        book.title = data['title']
    db.session.commit()
    return jsonify({'success': True, 'title': book.title})

@app.route('/api/note/<int:note_id>', methods=['DELETE'])
def delete_note(note_id):
    note = Note.query.get_or_404(note_id)
    db.session.delete(note)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/highlight/<int:highlight_id>', methods=['DELETE'])
def delete_highlight(highlight_id):
    highlight = Highlight.query.get_or_404(highlight_id)
    db.session.delete(highlight)
    db.session.commit()
    return jsonify({'success': True})

@app.errorhandler(Exception)
def handle_exception(e):
    # Pass through HTTP errors
    if hasattr(e, 'code'):
        return jsonify({'error': str(e)}), e.code
    
    import traceback
    return jsonify({
        'error': str(e),
        'traceback': traceback.format_exc()
    }), 500

if __name__ == '__main__':
    # Local development
    if not os.environ.get('POSTGRES_URL'):
        with app.app_context():
            try:
                db.create_all()
                if not os.path.exists('uploads'): os.makedirs('uploads')
            except Exception:
                pass
    app.run(debug=True)
