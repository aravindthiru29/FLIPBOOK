import fitz
import os

filepath = r"d:\Arav\FLIP book - final\uploads\0fbea468_CS3551-Distributed-Computing-Lecture-Notes-1_copy.pdf"
output_folder = r"d:\Arav\FLIP book - final\static\pages\1"

try:
    doc = fitz.open(filepath)
    print(f"Success! PDF has {len(doc)} pages.")
    page = doc.load_page(0)
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
    dest_path = os.path.join(output_folder, "test_page_0.jpg")
    pix.save(dest_path)
    print(f"Saved test image to {dest_path}")
    doc.close()
except Exception as e:
    print(f"Error: {str(e)}")
