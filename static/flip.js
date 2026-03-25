class Flipbook {
  constructor() {
    this.book = document.getElementById("book");
    this.prevBtn = document.getElementById("prevBtn");
    this.nextBtn = document.getElementById("nextBtn");
    this.pageIndicator = document.getElementById("pageIndicator");
    this.loadingOverlay = document.getElementById("loadingOverlay");
    
    this.bookId = window.bookId || 1;
    this.totalPages = window.totalPages || 10;
    this.currentSpread = 1;
    this.isAnimating = false;
    
    // Snappier duration (matches CSS transition)
    this.animDuration = 600; 

    this.init();
  }

  init() {
    this.renderPages();
    this.setupEvents();
    this.updateUI();

    setTimeout(() => {
      if(this.loadingOverlay) this.loadingOverlay.style.display = "none";
    }, 800);
  }

  renderPages() {
    this.book.innerHTML = ""; // Clear fallback content
    let spreadIndex = 1;

    for (let i = 0; i < this.totalPages; i += 2) {
      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper";
      wrapper.dataset.index = spreadIndex;
      
      // Top pages get higher z-index initially
      wrapper.style.zIndex = this.totalPages - spreadIndex;

      // FRONT PAGE (Right side)
      const front = document.createElement("div");
      front.className = "page front";
      const imgFront = document.createElement("img");
      imgFront.src = `/api/book/${this.bookId}/page/${i}`;
      imgFront.loading = "lazy"; // Prevents lag spikes when rendering
      front.appendChild(imgFront);

      // BACK PAGE (Left side)
      const back = document.createElement("div");
      back.className = "page back";
      if (i + 1 < this.totalPages) {
        const imgBack = document.createElement("img");
        imgBack.src = `/api/book/${this.bookId}/page/${i + 1}`;
        imgBack.loading = "lazy";
        back.appendChild(imgBack);
      }

      wrapper.appendChild(front);
      wrapper.appendChild(back);
      this.book.appendChild(wrapper);
      
      spreadIndex++;
    }
  }

  setupEvents() {
    if(this.nextBtn) this.nextBtn.onclick = () => this.nextPage();
    if(this.prevBtn) this.prevBtn.onclick = () => this.prevPage();

    // Keyboard Support
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") this.nextPage();
      if (e.key === "ArrowLeft") this.prevPage();
    });

    // Swipe Support (Passive true for smoother scrolling)
    let startX = 0;
    this.book.addEventListener("touchstart", (e) => {
      startX = e.changedTouches[0].screenX;
    }, { passive: true });
    
    this.book.addEventListener("touchend", (e) => {
      let endX = e.changedTouches[0].screenX;
      if (startX - endX > 50) this.nextPage();
      if (endX - startX > 50) this.prevPage();
    });
  }

  nextPage() {
    if (this.isAnimating) return;
    const wrapper = this.book.querySelector(`.page-wrapper[data-index="${this.currentSpread}"]`);
    if (!wrapper) return;

    this.isAnimating = true;

    // CRITICAL FIX: Swap z-index halfway through the flip so it lands cleanly on the left stack
    setTimeout(() => {
      wrapper.style.zIndex = this.currentSpread;
    }, this.animDuration / 2);

    wrapper.classList.add("flipped");
    this.currentSpread++;
    this.updateUI();

    setTimeout(() => (this.isAnimating = false), this.animDuration);
  }

  prevPage() {
    if (this.isAnimating || this.currentSpread <= 1) return;
    this.isAnimating = true;
    this.currentSpread--;

    const wrapper = this.book.querySelector(`.page-wrapper[data-index="${this.currentSpread}"]`);
    if (!wrapper) {
      this.isAnimating = false;
      return;
    }

    // CRITICAL FIX: Swap z-index back halfway through the reverse flip
    setTimeout(() => {
      wrapper.style.zIndex = this.totalPages - this.currentSpread;
    }, this.animDuration / 2);

    wrapper.classList.remove("flipped");
    this.updateUI();

    setTimeout(() => (this.isAnimating = false), this.animDuration);
  }

  updateUI() {
    if (!this.pageIndicator) return;
    let pageNum = (this.currentSpread - 1) * 2 + 1;
    if (pageNum > this.totalPages) pageNum = this.totalPages;
    this.pageIndicator.innerText = `Page ${pageNum} of ${this.totalPages}`;
  }
}

window.onload = () => new Flipbook();