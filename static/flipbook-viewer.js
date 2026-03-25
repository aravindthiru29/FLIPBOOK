let currentMode = null;
let currentHighlightColor = 'yellow';
let allNotes = [];
let allHighlights = [];

let currentAudioIndex = 0;
let audioUnlocked = false;

// Smooth Audio Engine
function playPageTurnSound() {
    const audioIds = ['page-turn-sound-1', 'page-turn-sound-2'];
    const audio = document.getElementById(audioIds[currentAudioIndex]);
    currentAudioIndex = (currentAudioIndex + 1) % audioIds.length;

    if (audio && audioUnlocked) {
        audio.volume = 0.6; // Slightly softer, more premium sound
        audio.currentTime = 0;
        audio.play().catch(() => { });
    }
}

$(document).ready(function () {
    const $flipbook = $('#flipbook');
    const $rangeDisplay = $('#current-pages-range');
    const $mobileRangeDisplay = $('#current-pages-range-mobile');
    const $loadingPopup = $('#flipbook-loading');
    const $mobileCanvas = $('#mobile-page-canvas'); // Assuming you have this in your mobile view
    
    const PDF_PAGE_COUNT = parseInt(WINDOW_BOOK_DATA.page_count, 10) || 0;
    const BOOK_ID = WINDOW_BOOK_DATA.id;
    
    const renderedPages = new Set();
    const quickRenderedPages = new Set();
    const renderingPages = new Map();
    let pdfDocumentPromise = null;
    
    let mobilePageIndex = 0;
    let viewportMode = window.innerWidth < 768 ? 'mobile' : 'desktop';
    
    // Zoom & Pan State
    let mobileZoom = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let startX, startY;

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    // Unlock audio on first interaction
    $(document).one('pointerdown keydown touchstart', () => {
        unlockAudio();
    });

    function getPdfDocument() {
        if (!pdfDocumentPromise) {
            pdfDocumentPromise = pdfjsLib.getDocument(WINDOW_BOOK_DATA.pdf_url).promise;
        }
        return pdfDocumentPromise;
    }

    function unlockAudio() {
        if (audioUnlocked) return;
        const audioIds = ['page-turn-sound-1', 'page-turn-sound-2'];
        audioIds.forEach((audioId) => {
            const audio = document.getElementById(audioId);
            if (!audio) return;
            audio.muted = true;
            audio.play().then(() => {
                audio.pause();
                audio.currentTime = 0;
                audio.muted = false;
                audioUnlocked = true;
            }).catch(() => { });
        });
    }

    function isMobileViewport() {
        return window.innerWidth <= 768 || (window.innerHeight < 500 && window.innerWidth < 950);
    }

    // --- ANNOTATION ENGINE ---
    function preloadAnnotations() {
        Promise.all([
            fetch(`/api/book/${BOOK_ID}/notes`).then(r => r.json()),
            fetch(`/api/book/${BOOK_ID}/highlights`).then(r => r.json())
        ]).then(([notes, highlights]) => {
            allNotes = Array.isArray(notes) ? notes : [];
            allHighlights = Array.isArray(highlights) ? highlights : [];
            if(!isMobileViewport()) {
                const currentView = $flipbook.turn('view');
                load(currentView);
            }
        }).catch(err => {
            console.error('Failed to load annotations:', err);
        });
    }

    function loadAnnotations(pageNum, $pageEl) {
        $pageEl.find('.note-marker, .highlight-marker').remove();
        allNotes.filter(n => n.page_number == pageNum).forEach(n => renderNote(n, $pageEl));
        allHighlights.filter(h => h.page_number == pageNum).forEach(h => renderHighlight(h, $pageEl));
    }

    function clearAnnotationSelection() {
        $('.note-marker, .highlight-marker').removeClass('annotation-selected ring-2 ring-brandMaroon scale-110');
    }

    function selectAnnotation($el) {
        clearAnnotationSelection();
        $el.addClass('annotation-selected ring-2 ring-brandMaroon scale-110');
    }

    function renderNote(note, $container) {
        const $layer = $container.find('.annotations-layer');
        const $el = $(`
            <div class="note-marker absolute z-30 transition-transform duration-300 cursor-pointer shadow-lg rounded-md bg-yellow-100 p-1" style="left:${note.x}%; top:${note.y}%" title="${note.content}">
                <i class="fa-solid fa-note-sticky text-yellow-600 text-sm"></i>
                ${WINDOW_BOOK_DATA.can_annotate ? `
                <div class="delete-annotation absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center hidden" onclick="deleteNote(${note.id}, this); event.stopPropagation();">
                    <i class="fa-solid fa-xmark text-[8px]"></i>
                </div>` : ''}
            </div>
        `);
        
        $el.hover(
            function() { $(this).find('.delete-annotation').removeClass('hidden'); },
            function() { $(this).find('.delete-annotation').addClass('hidden'); }
        );

        $el.click((e) => {
            if (currentMode) return;
            selectAnnotation($el);
            alert(`Note: ${note.content}`);
            e.stopPropagation();
        });
        $layer.append($el);
        return $el;
    }

    function renderHighlight(hl, $container) {
        const $layer = $container.find('.annotations-layer');
        const rect = hl.coordinates;
        
        // Brand-aligned highlight colors
        const colorStyles = {
            yellow: 'bg-yellow-300/40 border-yellow-400/80',
            green: 'bg-emerald-300/40 border-emerald-400/80',
            pink: 'bg-pink-300/40 border-pink-400/80',
            blue: 'bg-blue-300/40 border-blue-400/80'
        };
        const colorClass = colorStyles[hl.color || 'yellow'];

        const $el = $(`
            <div class="highlight-marker absolute border-dashed border ${colorClass} cursor-pointer transition-all duration-300 hover:bg-opacity-60" style="left:${rect.x}%; top:${rect.y}%; width:${rect.w}%; height:${rect.h}%;">
                ${WINDOW_BOOK_DATA.can_annotate ? `
                <div class="delete-annotation absolute -top-3 -right-3 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center shadow-md hidden" onclick="deleteHighlight(${hl.id}, this); event.stopPropagation();">
                    <i class="fa-solid fa-xmark text-[10px]"></i>
                </div>` : ''}
            </div>
        `);

        $el.hover(
            function() { $(this).find('.delete-annotation').removeClass('hidden'); },
            function() { $(this).find('.delete-annotation').addClass('hidden'); }
        );

        $el.on('click touchstart', function (e) {
            if (currentMode) return;
            selectAnnotation($el);
            e.stopPropagation();
        });
        $layer.append($el);
        return $el;
    }

    // --- PDF RENDERING ENGINE ---
    function getViewportForPage(page, $pageEl, isQuickRender) {
        const baseViewport = page.getViewport({ scale: 1 });
        const containerWidth = $pageEl.innerWidth() || 700;
        const containerHeight = $pageEl.innerHeight() || 900;
        const fitScale = Math.min(
            containerWidth / baseViewport.width,
            containerHeight / baseViewport.height
        );
        const deviceScale = window.devicePixelRatio || 1;
        const qualityScale = isQuickRender ? 1 : deviceScale;
        const viewport = page.getViewport({ scale: Math.max(fitScale, 0.1) * qualityScale });

        return { viewport, qualityScale };
    }

    async function renderPdfPage($pageEl, options = {}) {
        const pageNum = parseInt($pageEl.data('page'), 10);
        const isQuickRender = options.quick === true;
        if (!Number.isInteger(pageNum) || renderedPages.has(pageNum)) return;

        const renderKey = `${pageNum}:${isQuickRender ? 'quick' : 'full'}`;
        if (renderingPages.has(renderKey)) return renderingPages.get(renderKey);
        if (isQuickRender && quickRenderedPages.has(pageNum)) return;
        if (!isQuickRender && renderedPages.has(pageNum)) return;

        const renderPromise = (async () => {
            const canvas = $pageEl.find('.pdf-page-canvas').get(0);
            if (!canvas) return;

            try {
                const pdf = await getPdfDocument();
                const page = await pdf.getPage(pageNum + 1);
                const { viewport, qualityScale } = getViewportForPage(page, $pageEl, isQuickRender);
                const context = canvas.getContext('2d', { alpha: false });

                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                canvas.style.width = `${Math.floor(viewport.width / qualityScale)}px`;
                canvas.style.height = `${Math.floor(viewport.height / qualityScale)}px`;

                await page.render({ canvasContext: context, viewport }).promise;
                canvas.style.opacity = '1';
                
                if (isQuickRender) {
                    quickRenderedPages.add(pageNum);
                    window.setTimeout(() => renderPdfPage($pageEl, { quick: false }), 50);
                } else {
                    renderedPages.add(pageNum);
                }
            } catch (error) {
                console.error(`PDF render failed for page ${pageNum + 1}:`, error);
                handleCanvasError(canvas, pageNum);
            } finally {
                renderingPages.delete(renderKey);
            }
        })();

        renderingPages.set(renderKey, renderPromise);
        return renderPromise;
    }

    function load(view) {
        view.forEach(v => {
            if (v <= 0) return;
            const $p = $flipbook.find(`.page[data-page="${v - 2}"]`);
            if ($p.length === 0) return;

            const pageNum = $p.data('page');
            renderPdfPage($p, { quick: pageNum === 0 && !quickRenderedPages.has(pageNum) });

            if (pageNum !== undefined) {
                loadAnnotations(pageNum, $p);
            }
        });
    }

    const debouncedLoad = _.debounce(function (view) {
        load(view);
    }, 100);

    function preloadPages(currentPage) {
        const pagesToPreload = [];
        for (let i = 1; i <= 6; i++) {
            const nextP = currentPage + i;
            if (nextP <= PDF_PAGE_COUNT + 2) pagesToPreload.push(nextP);
        }
        if (pagesToPreload.length > 0) load(pagesToPreload);
    }

    // --- BOOK SIZING & INIT ---
    function getBookSize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        // Force Single Page on Mobile, Double on Desktop
        if (isMobileViewport()) {
            const maxWidth = width * 0.95;
            const maxHeight = height * 0.85;
            const portraitRatio = 0.72;
            let w = Math.min(maxWidth, maxHeight * portraitRatio);
            let h = w / portraitRatio;

            if (h > maxHeight) {
                h = maxHeight;
                w = h * portraitRatio;
            }
            return { width: w, height: h, display: 'single' };
        }

        const w = Math.min(1200, width * 0.9);
        const h = (w / 1000) * 700;
        return { width: w, height: h, display: 'double' };
    }

    try {
        const initialSize = getBookSize();
        $flipbook.turn({
            width: initialSize.width,
            height: initialSize.height,
            display: initialSize.display,
            autoCenter: true,
            gradients: true,
            acceleration: true, // Hardware acceleration for real-time smoothness
            elevation: 50,
            duration: 1200, // Slightly slower duration makes physics feel more realistic
            when: {
                turning: function (e, page, view) {
                    debouncedLoad(view);
                    playPageTurnSound();
                },
                turned: function (e, page, view) {
                    let pdfPages = view.map(v => v - 2).filter(v => v >= 0 && v < PDF_PAGE_COUNT);
                    let displayTxt = 'Cover';
                    if (pdfPages.length > 0) {
                        displayTxt = pdfPages.length > 1 ? `${pdfPages[0] + 1} - ${pdfPages[1] + 1}` : `${pdfPages[0] + 1}`;
                    } else if (view.includes($flipbook.turn('pages'))) {
                        displayTxt = 'End';
                    }
                    $rangeDisplay.text(displayTxt);
                    $mobileRangeDisplay.text(displayTxt);
                    preloadPages(page);
                }
            }
        });
    } catch (e) {
        console.error('Turn.js error:', e);
    }

    // --- REAL-TIME SCROLL / DRAG / ZOOM ENGINE (Desktop & Mobile) ---
    
    // Zoom Logic
    const viewport = document.getElementById('flipbook-outer');
    
    function applyZoom() {
        if(viewport) {
            viewport.style.transform = `scale(${mobileZoom}) translate(${panX}px, ${panY}px)`;
            viewport.style.transition = isDragging ? 'none' : 'transform 0.3s ease-out';
        }
    }

    $('#zoom-in-btn').click(() => { mobileZoom = Math.min(mobileZoom + 0.2, 2.5); applyZoom(); });
    $('#zoom-out-btn').click(() => { mobileZoom = Math.max(mobileZoom - 0.2, 0.5); panX = 0; panY = 0; applyZoom(); });

    // Double Tap to Zoom (Native feel)
    let lastTap = 0;
    $(document).on('touchend', '#flipbook-outer', function(e) {
        let currentTime = new Date().getTime();
        let tapLength = currentTime - lastTap;
        if (tapLength < 300 && tapLength > 0) {
            mobileZoom = mobileZoom > 1 ? 1 : 1.8; // Toggle zoom
            panX = 0; panY = 0;
            applyZoom();
            e.preventDefault();
        }
        lastTap = currentTime;
    });

    // Real-Time Touch Dragging (Pan when zoomed, swipe to turn when 1x)
    let dragStartX = 0;
    let dragStartY = 0;

    $(document).on('touchstart mousedown', '#flipbook-outer', function(e) {
        if ($(e.target).closest('button, .note-marker, .highlight-marker').length) return;
        if (currentMode) return; // Don't drag if highlighting/noting

        isDragging = true;
        dragStartX = e.type.includes('touch') ? e.originalEvent.touches[0].clientX : e.clientX;
        dragStartY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        
        if (mobileZoom > 1) {
            viewport.style.transition = 'none'; // Instant pan
        }
    });

    $(document).on('touchmove mousemove', function(e) {
        if (!isDragging) return;
        
        let clientX = e.type.includes('touch') ? e.originalEvent.touches[0].clientX : e.clientX;
        let clientY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        
        let deltaX = clientX - dragStartX;
        let deltaY = clientY - dragStartY;

        if (mobileZoom > 1) {
            // Panning around zoomed page
            panX += deltaX * 0.05;
            panY += deltaY * 0.05;
            applyZoom();
        } else {
            // Real-time Swiping on Mobile
            if (isMobileViewport() && Math.abs(deltaX) > 20) {
                // Not utilizing turn.js corner peel on mobile, using entire canvas shift
                let shift = Math.max(-100, Math.min(100, deltaX)); // Clamp movement
                viewport.style.transform = `translateX(${shift}px)`;
                viewport.style.transition = 'none';
            }
        }
    });

    $(document).on('touchend mouseup', function(e) {
        if (!isDragging) return;
        isDragging = false;

        let endX = e.type.includes('touch') ? e.originalEvent.changedTouches[0].clientX : e.clientX;
        let swipeDistance = endX - dragStartX;

        // Reset transforms
        viewport.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
        
        if (mobileZoom === 1) {
            viewport.style.transform = `scale(1) translate(0px, 0px)`;
            
            // Execute Turn if swiped far enough
            if (swipeDistance > 75) {
                $flipbook.turn('previous');
            } else if (swipeDistance < -75) {
                $flipbook.turn('next');
            }
        }
    });

    // Keyboard & Mouse Wheel Navigation
    let isWheeling = false;
    $(window).on('wheel', function (e) {
        if (isWheeling || currentMode || mobileZoom > 1) return;
        const deltaX = e.originalEvent.deltaX;
        
        if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(e.originalEvent.deltaY)) {
            isWheeling = true;
            if (deltaX > 0) $flipbook.turn('next');
            else $flipbook.turn('previous');
            setTimeout(() => { isWheeling = false; }, 600);
        }
    });

    $(window).bind('keydown', function (e) {
        if (e.keyCode === 37) $flipbook.turn('previous');
        else if (e.keyCode === 39) $flipbook.turn('next');
    });

    // Nav Button Bindings
    $('#prev-btn, #mobile-prev-btn').click(() => { unlockAudio(); $flipbook.turn('previous'); });
    $('#next-btn, #mobile-next-btn').click(() => { unlockAudio(); $flipbook.turn('next'); });

    // Handle Window Resize
    $(window).resize(_.debounce(function () {
        const nextMode = isMobileViewport() ? 'mobile' : 'desktop';
        if (nextMode !== viewportMode) {
            window.location.reload();
            return;
        }
        
        const size = getBookSize();
        if ($flipbook.turn('is')) {
            $flipbook.turn('size', size.width, size.height);
            $flipbook.turn('display', size.display);
            renderedPages.clear();
            quickRenderedPages.clear();
            load($flipbook.turn('view'));
        }
    }, 200));

    // --- ANNOTATION CREATION LOGIC ---
    let highlightStart = null;
    let $highlightPreview = null;

    $(document).on('click', '.annotations-layer', function (e) {
        if (!currentMode || currentMode === 'highlight') return;

        const $layer = $(this);
        const $page = $layer.closest('.page');
        const pageNum = $page.data('page');
        const offset = $layer.offset();
        const x = ((e.pageX - offset.left) / $layer.width()) * 100;
        const y = ((e.pageY - offset.top) / $layer.height()) * 100;

        if (currentMode === 'note') {
            const content = prompt('Enter note content:');
            if (content) {
                fetch(`/api/book/${BOOK_ID}/notes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ page_number: pageNum, content, x, y })
                })
                .then(r => r.json())
                .then(d => {
                    if (d.success) {
                        const newNote = { id: d.id, page_number: pageNum, content, x, y };
                        allNotes.push(newNote);
                        const $noteEl = renderNote(newNote, $page);
                        selectAnnotation($noteEl);
                    } else {
                        alert('Error: ' + (d.error || 'Failed to create note'));
                    }
                }).catch(err => console.error('Add note error:', err));
            }
            setMode(null);
        }
    });

    $(document).on('mousedown touchstart', '.annotations-layer', function (e) {
        if (currentMode !== 'highlight') return;
        if ($(e.target).closest('.delete-annotation').length) return;

        e.preventDefault();
        const $layer = $(this);
        const $page = $layer.closest('.page');
        const offset = $layer.offset();

        const startClientX = e.type.includes('touch') ? e.originalEvent.touches[0].clientX : e.clientX;
        const startClientY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        const startX = startClientX - offset.left;
        const startY = startClientY - offset.top;

        highlightStart = { x: startX, y: startY, pageNum: $page.data('page'), $page, $layer, offset };

        const colorStyles = {
            yellow: { bg: 'rgba(253, 224, 71, 0.4)', border: 'rgba(250, 204, 21, 0.8)' },
            green: { bg: 'rgba(110, 231, 183, 0.4)', border: 'rgba(52, 211, 153, 0.8)' },
            pink: { bg: 'rgba(249, 168, 212, 0.4)', border: 'rgba(244, 114, 182, 0.8)' },
            blue: { bg: 'rgba(147, 197, 253, 0.4)', border: 'rgba(96, 165, 250, 0.8)' }
        };
        const style = colorStyles[currentHighlightColor] || colorStyles.yellow;
        $highlightPreview = $(`<div class="highlight-preview absolute z-40" style="background: ${style.bg}; border: 1px dashed ${style.border}; pointer-events: none;"></div>`);
        $layer.append($highlightPreview);
    });

    $(document).on('mousemove touchmove', function (e) {
        if (!highlightStart || !$highlightPreview) return;

        const currentClientX = e.type.includes('touch') ? e.originalEvent.touches[0].clientX : e.clientX;
        const currentClientY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        const currentX = currentClientX - highlightStart.offset.left;
        const currentY = currentClientY - highlightStart.offset.top;

        const left = Math.min(highlightStart.x, currentX);
        const top = Math.min(highlightStart.y, currentY);
        const width = Math.abs(currentX - highlightStart.x);
        const height = Math.abs(currentY - highlightStart.y);

        $highlightPreview.css({ left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    });

    $(document).on('mouseup touchend', function (e) {
        if (!highlightStart || !$highlightPreview) return;

        const { $layer, $page, pageNum, offset, x: startX, y: startY } = highlightStart;

        const endClientX = e.type.includes('touch') ? e.originalEvent.changedTouches[0].clientX : e.clientX;
        const endClientY = e.type.includes('touch') ? e.originalEvent.changedTouches[0].clientY : e.clientY;
        const endX = endClientX - offset.left;
        const endY = endClientY - offset.top;

        if (Math.abs(endX - startX) > 10 || Math.abs(endY - startY) > 10) {
            const left = Math.min(startX, endX);
            const top = Math.min(startY, endY);
            
            const x = (left / $layer.width()) * 100;
            const y = (top / $layer.height()) * 100;
            const w = (Math.abs(endX - startX) / $layer.width()) * 100;
            const h = (Math.abs(endY - startY) / $layer.height()) * 100;

            fetch(`/api/book/${BOOK_ID}/highlights`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ page_number: pageNum, coordinates: { x, y, w, h }, color: currentHighlightColor })
            }).then(r => r.json()).then(d => {
                if (d.success) {
                    const newHighlight = { id: d.id, page_number: pageNum, coordinates: { x, y, w, h }, color: currentHighlightColor };
                    allHighlights.push(newHighlight);
                    const $highlightEl = renderHighlight(newHighlight, $page);
                    selectAnnotation($highlightEl);
                } else {
                    alert('Error: ' + (d.error || 'Failed to create highlight'));
                }
            }).catch(err => console.error('Add highlight error:', err));
        }

        $highlightPreview.remove();
        highlightStart = null;
        $highlightPreview = null;
    });

    setTimeout(() => {
        getPdfDocument().then(() => {
            preloadAnnotations();
        }).catch(error => {
            console.error('PDF document load failed:', error);
            $('#flipbook-loading h2').text('Error loading document');
            $('#flipbook-loading p:last-child').text('Please refresh the page.');
        });
    }, 300);

    $(document).on('click touchstart', function (e) {
        if ($(e.target).closest('.note-marker, .highlight-marker, .delete-annotation, #note-mode-btn, #highlight-mode-btn, #color-picker').length) return;
        clearAnnotationSelection();
    });
});

// Utility Functions globally accessible
window.handleCanvasError = function(canvas, pageNum) {
    if (!canvas || !canvas.parentElement) return;
    canvas.style.opacity = '1';
    const existing = canvas.parentElement.querySelector('.pdf-error-overlay');
    if (existing) return;

    const errorDiv = document.createElement('div');
    errorDiv.className = 'pdf-error-overlay absolute inset-0 flex flex-col gap-2 items-center justify-center text-center bg-red-50 text-red-800 p-4 z-10';
    errorDiv.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-2xl"></i><br><b>Render Error (Page ${pageNum + 1})</b><br><small>Canvas failed to draw.</small>`;
    canvas.parentElement.appendChild(errorDiv);
};

window.toggleMode = function(mode) {
    if (currentMode === mode) setMode(null);
    else setMode(mode);
};

window.setHighlightColor = function(color) {
    currentHighlightColor = color;
    $('#color-yellow, #color-green, #color-pink, #color-blue').removeClass('ring-2 ring-offset-2 ring-brandNavy');
    $(`#color-${color}`).addClass('ring-2 ring-offset-2 ring-brandNavy');
};

window.setMode = function(mode) {
    currentMode = mode;
    $('#note-mode-btn, #highlight-mode-btn').removeClass('text-brandMaroon bg-brandMaroon/10 shadow-inner');
    $('#color-picker').addClass('hidden');

    if (mode === 'note') {
        $('#note-mode-btn').addClass('text-brandMaroon bg-brandMaroon/10 shadow-inner');
        document.body.style.cursor = 'crosshair';
    } else if (mode === 'highlight') {
        $('#highlight-mode-btn').addClass('text-brandMaroon bg-brandMaroon/10 shadow-inner');
        $('#color-picker').removeClass('hidden');
        document.body.style.cursor = 'text';
    } else {
        document.body.style.cursor = 'default';
    }
};

window.deleteNote = function(id, el) {
    if (!confirm('Delete this note?')) return;
    fetch(`/api/note/${id}`, { method: 'DELETE' }).then(r => r.json()).then(d => {
        if (d.success) { $(el).closest('.note-marker').remove(); allNotes = allNotes.filter(n => n.id !== id); }
    });
};

window.deleteHighlight = function(id, el) {
    if (!confirm('Remove highlight?')) return;
    fetch(`/api/highlight/${id}`, { method: 'DELETE' }).then(r => r.json()).then(d => {
        if (d.success) { $(el).closest('.highlight-marker').remove(); allHighlights = allHighlights.filter(h => h.id !== id); }
    });
};

window.toggleWarmth = function() {
    $('body').toggleClass('warm-mode');
    const isWarm = $('body').hasClass('warm-mode');
    // Simulate night shift/warmth filter
    $('#flipbook-outer').css('filter', isWarm ? 'sepia(0.3) brightness(0.9) contrast(0.9)' : 'none');
};