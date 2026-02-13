class Flipbook {
  constructor() {
    this.book = document.getElementById("book");
    this.prevBtn = document.getElementById("prevBtn");
    this.nextBtn = document.getElementById("nextBtn");
    this.pageIndicator = document.getElementById("pageIndicator");
    this.loadingOverlay = document.getElementById("loadingOverlay");
    this.bookId = window.bookId;
    this.totalPages = window.totalPages;
    this.currentSpread = 1;
    this.isAnimating = false;
    this.init();
  }

  init() {
    this.renderPages();
    this.setupEvents();
    this.updateUI();

    setTimeout(() => {
      this.loadingOverlay.style.display = "none";
    }, 800);
  }

  renderPages() {
    for (let i = 0; i < this.totalPages; i += 2) {
      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper right";
      wrapper.dataset.index = i / 2 + 1;
      wrapper.style.zIndex = this.totalPages - i;
      // FRONT PAGE
      const front = document.createElement("div");
      front.className = "page front";
      const imgFront = document.createElement("img");
      imgFront.src = `/api/book/${this.bookId}/page/${i}`;
      front.appendChild(imgFront);
      // BACK PAGE
      const back = document.createElement("div");
      back.className = "page back";
      if (i + 1 < this.totalPages) {
        const imgBack = document.createElement("img");
        imgBack.src = `/api/book/${this.bookId}/page/${i + 1}`;
        back.appendChild(imgBack);
      }
      wrapper.appendChild(front);
      wrapper.appendChild(back);
      this.book.appendChild(wrapper);
    }
  }
  setupEvents() {
    this.nextBtn.onclick = () => this.nextPage();
    this.prevBtn.onclick = () => this.prevPage();
    // Keyboard Support
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") this.nextPage();
      if (e.key === "ArrowLeft") this.prevPage();
    });
    // Swipe Support
    let startX = 0;
    this.book.addEventListener("touchstart", (e) => {
      startX = e.changedTouches[0].screenX;
    });
    this.book.addEventListener("touchend", (e) => {
      let endX = e.changedTouches[0].screenX;
      if (startX - endX > 50) this.nextPage();
      if (endX - startX > 50) this.prevPage();
    });
  }
  nextPage() {
    if (this.isAnimating) return;
    const wrapper = this.book.querySelector(
      `.page-wrapper[data-index="${this.currentSpread}"]`
    );
    if (!wrapper) return;
    this.isAnimating = true;
    wrapper.classList.add("flipped");
    this.currentSpread++;
    this.updateUI();
    setTimeout(() => (this.isAnimating = false), 1000);
  }
  prevPage() {
    if (this.isAnimating) return;
    if (this.currentSpread <= 1) return;
    this.currentSpread--;
    const wrapper = this.book.querySelector(
      `.page-wrapper[data-index="${this.currentSpread}"]`
    );
    if (!wrapper) return;
    this.isAnimating = true;
    wrapper.classList.remove("flipped");
    this.updateUI();
    setTimeout(() => (this.isAnimating = false), 1000);
  }
  updateUI() {
    let pageNum = (this.currentSpread - 1) * 2 + 1;
    if (pageNum > this.totalPages) pageNum = this.totalPages;
    this.pageIndicator.innerText = `Page ${pageNum} of ${this.totalPages}`;
  }
}
window.onload = () => new Flipbook();