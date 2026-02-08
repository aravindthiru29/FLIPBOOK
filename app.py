import os
import fitz  # PyMuPDF
import json
import uuid
import threading
from datetime import datetime
from flask import Flask, render_template, request, send_from_directory, jsonify, url_for
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///flipbook.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['PAGES_FOLDER'] = os.path.join('static', 'pages')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB limit

db = SQLAlchemy(app)

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
    doc = fitz.open(filepath)
    toc = doc.get_toc()
    page_count = doc.page_count
    doc.close()
    return page_count, toc

def render_pdf_page(filepath, page_num, output_folder):
    doc = fitz.open(filepath)
    page = doc.load_page(page_num)
    # Using Matrix(2.0, 2.0) for high quality clear text
    pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0)) 
    
    filename = f"page_{page_num}.jpg"
    dest_path = os.path.join(output_folder, filename)
    
    if not os.path.exists(output_folder):
        os.makedirs(output_folder)
        
    pix.save(dest_path)
    doc.close()
    return filename

def pre_render_book(filepath, book_id, page_count):
    """Background task to pre-render all pages"""
    output_folder = os.path.join(os.getcwd(), app.config['PAGES_FOLDER'], str(book_id))
    print(f"Starting background pre-rendering for book {book_id} in {output_folder}...")
    
    doc = fitz.open(filepath)
    for i in range(page_count):
        page_filename = f"page_{i}.jpg"
        page_path = os.path.join(output_folder, page_filename)
        
        if not os.path.exists(page_path):
            page = doc.load_page(i)
            # Match high quality for background pre-rendering as well
            pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0)) 
            if not os.path.exists(output_folder):
                os.makedirs(output_folder)
            pix.save(page_path)
    
    doc.close()
    print(f"Background pre-rendering complete for book {book_id}")

# --- Routes ---
@app.route('/')
def index():
    books = Book.query.order_by(Book.created_at.desc()).all()
    return render_template('index.html', books=books)

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file and file.filename.lower().endswith('.pdf'):
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

@app.route('/book/<int:book_id>')
def view_book(book_id):
    book = Book.query.get_or_404(book_id)
    return render_template('flipbook.html', book_data=book)

@app.route('/api/book/<int:book_id>/page/<int:page_num>')
def get_page(book_id, page_num):
    book = Book.query.get_or_404(book_id)
    file_path = os.path.join(os.getcwd(), app.config['UPLOAD_FOLDER'], book.filename)
    
    # Check if page is already rendered
    book_page_folder = os.path.join(os.getcwd(), app.config['PAGES_FOLDER'], str(book_id))
    page_filename = f"page_{page_num}.jpg"
    page_path = os.path.join(book_page_folder, page_filename)
    
    if not os.path.exists(page_path):
        print(f"Rendering page {page_num} for book {book_id}...")
        try:
            render_pdf_page(file_path, page_num, book_page_folder)
            print(f"Successfully rendered {page_path}")
        except Exception as e:
            print(f"Error rendering page {page_num}: {str(e)}")
            return jsonify({'error': str(e)}), 500
        
    return send_from_directory(book_page_folder, page_filename)

@app.route('/api/book/<int:book_id>/toc')
def get_toc(book_id):
    book = Book.query.get_or_404(book_id)
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], book.filename)
    _, toc = get_pdf_metadata(file_path)
    return jsonify(toc)

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
    
    # Remove files
    try:
        # PDF file
        pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], book.filename)
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
            
        # Pages directory
        pages_dir = os.path.join(os.getcwd(), app.config['PAGES_FOLDER'], str(book_id))
        if os.path.exists(pages_dir):
            import shutil
            shutil.rmtree(pages_dir)
            
    except Exception as e:
        print(f"Error deleting files: {e}")
        # Note: We continue to delete from DB even if file deletion fails partially

    # Remove from DB
    db.session.delete(book)
    db.session.commit()
    
    return jsonify({'success': True})

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

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        if not os.path.exists(app.config['UPLOAD_FOLDER']):
            os.makedirs(app.config['UPLOAD_FOLDER'])
        if not os.path.exists(app.config['PAGES_FOLDER']):
            os.makedirs(app.config['PAGES_FOLDER'])
    app.run(debug=True)
