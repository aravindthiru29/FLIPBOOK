# 📖 FlipBook Web App

A web-based flipbook application built using Flask that delivers an interactive page-turning experience with added audio support. This project combines backend logic with frontend rendering to simulate a realistic digital book interface.

---

## 🚀 What This Project Does

This isn’t just a static UI.

The app renders a flipbook-style interface in the browser while also integrating backend functionality (Flask) to handle dynamic behavior and sound generation for a more immersive experience.

---

## ✨ Key Features

* 📄 Interactive flipbook UI with page transitions
* 🔊 Sound generation for page flip effects
* 🌐 Flask-powered backend
* 🎯 Template-based rendering using Jinja2
* 📦 Organized static and template structure
* ☁️ Ready for deployment (Vercel configured)

---

## 🛠️ Tech Stack

**Backend**

* Python (Flask)

**Frontend**

* HTML
* CSS
* JavaScript

**Deployment**

* Vercel

---

## 📂 Project Structure

```
FLIPBOOK/
│── instance/                # App instance config (Flask)
│── static/                  # CSS, JS, assets
│── templates/               # HTML templates (Jinja2)

│── app.py                   # Main Flask application
│── app-routes-snippet.py    # Route logic (modularized)
│── create_sound.py          # Sound generation logic

│── requirements.txt         # Python dependencies
│── vercel.json              # Deployment config
│── .gitignore
```

---

## ⚙️ Setup Instructions

### 1. Clone the repo

```bash
git clone https://github.com/aravindthiru29/FLIPBOOK.git
cd FLIPBOOK
```

### 2. Create virtual environment

```bash
python -m venv venv
source venv/bin/activate   # On Windows: venv\Scripts\activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Run the app

```bash
python app.py
```

### 5. Open in browser

```
http://127.0.0.1:5000/
```

---

## 🔍 How It Works

* Flask serves the frontend using templates
* Static assets handle UI rendering and animations
* Backend logic manages routing and interactions
* `create_sound.py` generates or processes audio for page flip effects

---

## 📌 Improvements You Should Seriously Consider

Right now, this project is decent — but not strong enough for hiring-level impact.

Fix that:

* Add **PDF upload → auto flipbook generator**
* Store books using **SQLite / Firebase**
* Add **user authentication**
* Improve animation using **WebGL or advanced CSS transforms**
* Deploy a **live demo (mandatory)**

---

## 🤝 Contributing

Pull requests are welcome. If you want to extend features, go ahead.

---

## 👨‍💻 Author

Aravind
GitHub: https://github.com/aravindthiru29
Live website - https://flipbook-woad.vercel.app/
---

## 📜 License

MIT License
