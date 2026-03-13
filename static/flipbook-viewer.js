let currentMode = null;
let currentHighlightColor = 'yellow';
let allNotes = [];
let allHighlights = [];

let currentAudioIndex = 0;
function playPageTurnSound() {
    const audioIds = ['page-turn-sound-1', 'page-turn-sound-2'];
    const audio = document.getElementById(audioIds[currentAudioIndex]);
    currentAudioIndex = (currentAudioIndex + 1) % audioIds.length;

    if (audio) {
        audio.volume = 1.0;
        audio.currentTime = 0;
        audio.play().catch(() => { });
    }
}

$(document).ready(function () {
    const $flipbook = $('#flipbook');
    const $rangeDisplay = $('#current-pages-range');
    const PDF_PAGE_COUNT = parseInt(WINDOW_BOOK_DATA.page_count, 10) || 0;
    const BOOK_ID = WINDOW_BOOK_DATA.id;
    const renderedPages = new Set();
    const quickRenderedPages = new Set();
    const renderingPages = new Map();
    let pdfDocumentPromise = null;

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    function getPdfDocument() {
        if (!pdfDocumentPromise) {
            pdfDocumentPromise = pdfjsLib.getDocument(WINDOW_BOOK_DATA.pdf_url).promise;
        }
        return pdfDocumentPromise;
    }

    function preloadAnnotations() {
        Promise.all([
            fetch(`/api/book/${BOOK_ID}/notes`).then(r => r.json()),
            fetch(`/api/book/${BOOK_ID}/highlights`).then(r => r.json())
        ]).then(([notes, highlights]) => {
            allNotes = Array.isArray(notes) ? notes : [];
            allHighlights = Array.isArray(highlights) ? highlights : [];
            const currentView = $flipbook.turn('view');
            load(currentView);
        }).catch(err => {
            console.error('Failed to load annotations:', err);
            allNotes = [];
            allHighlights = [];
        });
    }

    function loadAnnotations(pageNum, $pageEl) {
        $pageEl.find('.note-marker, .highlight-marker').remove();

        allNotes.filter(n => n.page_number == pageNum).forEach(n => {
            renderNote(n, $pageEl);
        });
        allHighlights.filter(h => h.page_number == pageNum).forEach(h => {
            renderHighlight(h, $pageEl);
        });
    }

    function clearAnnotationSelection() {
        $('.note-marker, .highlight-marker').removeClass('annotation-selected');
    }

    function selectAnnotation($el) {
        clearAnnotationSelection();
        $el.addClass('annotation-selected');
    }

    function renderNote(note, $container) {
        const $layer = $container.find('.annotations-layer');
        const $el = $(`
            <div class="note-marker" style="left:${note.x}%; top:${note.y}%" title="${note.content}">
                <i class="fas fa-sticky-note text-[10px]"></i>
                ${WINDOW_BOOK_DATA.is_admin ? `
                <div class="delete-annotation" onclick="deleteNote(${note.id}, this); event.stopPropagation();">
                    <i class="fas fa-times"></i>
                </div>` : ''}
            </div>
        `);
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
        const colorClass = `highlight-${hl.color || 'yellow'}`;
        const $el = $(`
            <div class="highlight-marker ${colorClass}" style="left:${rect.x}%; top:${rect.y}%; width:${rect.w}%; height:${rect.h}%;">
                ${WINDOW_BOOK_DATA.is_admin ? `
                <div class="delete-annotation" onclick="deleteHighlight(${hl.id}, this); event.stopPropagation();">
                    <i class="fas fa-times"></i>
                </div>` : ''}
            </div>
        `);
        $el.on('click touchstart', function (e) {
            if (currentMode) return;
            selectAnnotation($el);
            e.stopPropagation();
        });
        $layer.append($el);
        return $el;
    }

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
        if (!Number.isInteger(pageNum) || renderedPages.has(pageNum)) {
            return;
        }

        const renderKey = `${pageNum}:${isQuickRender ? 'quick' : 'full'}`;
        if (renderingPages.has(renderKey)) {
            return renderingPages.get(renderKey);
        }

        if (isQuickRender && quickRenderedPages.has(pageNum)) {
            return;
        }
        if (!isQuickRender && renderedPages.has(pageNum)) {
            return;
        }

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
            if (nextP <= PDF_PAGE_COUNT + 2) {
                pagesToPreload.push(nextP);
            }
        }
        if (pagesToPreload.length > 0) {
            load(pagesToPreload);
        }
    }

    function getBookSize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const isMobile = width < 768;

        if (isMobile) {
            const w = width * 0.95;
            const h = height * 0.7;
            return { width: w, height: h, display: 'single' };
        }

        const w = Math.min(1000, width * 0.9);
        const h = (w / 1000) * 700;
        return { width: w, height: h, display: 'double' };
    }

    function rerenderVisiblePages() {
        renderedPages.clear();
        quickRenderedPages.clear();
        $flipbook.find('.pdf-page-canvas').each(function () {
            this.width = 0;
            this.height = 0;
            this.style.opacity = '0';
            const existingError = this.parentElement.querySelector('.pdf-error-overlay');
            if (existingError) {
                existingError.remove();
            }
        });
        load($flipbook.turn('view'));
    }

    function resizeFlipbook() {
        const size = getBookSize();
        if ($flipbook.turn('is')) {
            $flipbook.turn('size', size.width, size.height);
            $flipbook.turn('display', size.display);
            rerenderVisiblePages();
        }
    }

    const initialSize = getBookSize();
    try {
        $flipbook.turn({
            width: initialSize.width,
            height: initialSize.height,
            display: initialSize.display,
            autoCenter: true,
            gradients: true,
            elevation: 100,
            duration: 600,
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
                    preloadPages(page);
                }
            }
        });
    } catch (e) {
        console.error('Turn.js error:', e);
    }

    $(window).resize(_.debounce(resizeFlipbook, 150));

    $('#prev-btn').click(() => $flipbook.turn('previous'));
    $('#next-btn').click(() => $flipbook.turn('next'));

    $(window).bind('keydown', function (e) {
        if (e.keyCode === 37) $flipbook.turn('previous');
        else if (e.keyCode === 39) $flipbook.turn('next');
    });

    $('#fullscreen-btn').click(() => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
    });

    let startX = 0;
    let isDown = false;

    $flipbook.on('touchstart mousedown', (e) => {
        if ($(e.target).closest('button, .note-marker, .highlight-marker, a, .delete-annotation').length) return;
        if (currentMode) return;

        isDown = true;
        startX = e.type === 'touchstart' ? e.originalEvent.touches[0].clientX : e.pageX;
    });

    $(window).on('touchend mouseup', (e) => {
        if (!isDown) return;
        isDown = false;

        let endX;
        if (e.type === 'touchend') {
            endX = e.originalEvent.changedTouches[0].clientX;
        } else {
            endX = e.pageX;
        }

        if (startX - endX > 100) $flipbook.turn('next');
        if (endX - startX > 100) $flipbook.turn('previous');
    });

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
                    })
                    .catch(err => {
                        console.error('Add note error:', err);
                        alert('Network error: Failed to create note');
                    });
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
        const pageNum = $page.data('page');
        const offset = $layer.offset();

        const startClientX = e.type.includes('touch') ? e.originalEvent.touches[0].clientX : e.clientX;
        const startClientY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        const startX = startClientX - offset.left;
        const startY = startClientY - offset.top;

        highlightStart = { x: startX, y: startY, pageNum, $page, $layer, offset };

        const colorStyles = {
            yellow: { bg: 'rgba(255, 255, 0, 0.4)', border: 'rgba(255, 165, 0, 0.8)' },
            green: { bg: 'rgba(34, 197, 94, 0.4)', border: 'rgba(34, 197, 94, 0.8)' },
            pink: { bg: 'rgba(244, 114, 182, 0.4)', border: 'rgba(244, 114, 182, 0.8)' },
            blue: { bg: 'rgba(59, 130, 246, 0.4)', border: 'rgba(59, 130, 246, 0.8)' }
        };
        const style = colorStyles[currentHighlightColor] || colorStyles.yellow;
        $highlightPreview = $(`<div class="highlight-preview" style="position: absolute; background: ${style.bg}; border: 1px dashed ${style.border}; pointer-events: none; z-index: 95;"></div>`);
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

        $highlightPreview.css({
            left: left + 'px',
            top: top + 'px',
            width: width + 'px',
            height: height + 'px'
        });
    });

    $(document).on('mouseup touchend', function (e) {
        if (!highlightStart || !$highlightPreview) return;

        const $layer = highlightStart.$layer;
        const $page = highlightStart.$page;
        const pageNum = highlightStart.pageNum;
        const offset = highlightStart.offset;

        const endClientX = e.type.includes('touch') ? e.originalEvent.changedTouches[0].clientX : e.clientX;
        const endClientY = e.type.includes('touch') ? e.originalEvent.changedTouches[0].clientY : e.clientY;
        const endX = endClientX - offset.left;
        const endY = endClientY - offset.top;

        if (Math.abs(endX - highlightStart.x) > 10 || Math.abs(endY - highlightStart.y) > 10) {
            const left = Math.min(highlightStart.x, endX);
            const top = Math.min(highlightStart.y, endY);
            const width = Math.abs(endX - highlightStart.x);
            const height = Math.abs(endY - highlightStart.y);

            const x = (left / $layer.width()) * 100;
            const y = (top / $layer.height()) * 100;
            const w = (width / $layer.width()) * 100;
            const h = (height / $layer.height()) * 100;

            fetch(`/api/book/${BOOK_ID}/highlights`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    page_number: pageNum,
                    coordinates: { x, y, w, h },
                    color: currentHighlightColor
                })
            })
                .then(r => r.json())
                .then(d => {
                    if (d.success) {
                        const newHighlight = { id: d.id, page_number: pageNum, coordinates: { x, y, w, h }, color: currentHighlightColor };
                        allHighlights.push(newHighlight);
                        const $highlightEl = renderHighlight(newHighlight, $page);
                        selectAnnotation($highlightEl);
                    } else {
                        alert('Error: ' + (d.error || 'Failed to create highlight'));
                    }
                })
                .catch(err => {
                    console.error('Add highlight error:', err);
                    alert('Network error: Failed to create highlight');
                });
        }

        $highlightPreview.remove();
        highlightStart = null;
        $highlightPreview = null;
    });

    setTimeout(() => {
        getPdfDocument()
            .then(() => {
                const currentView = $flipbook.turn('view');
                load(currentView);
                window.setTimeout(preloadAnnotations, 150);
                window.setTimeout(() => {
                    const lastPage = Math.max(...currentView);
                    preloadPages(lastPage);
                }, 80);
            })
            .catch(error => {
                console.error('PDF document load failed:', error);
                $flipbook.find('.page[data-page]').each(function () {
                    const pageNum = parseInt($(this).data('page'), 10);
                    const canvas = $(this).find('.pdf-page-canvas').get(0);
                    handleCanvasError(canvas, pageNum);
                });
            });
    }, 300);

    $(document).on('click touchstart', function (e) {
        if ($(e.target).closest('.note-marker, .highlight-marker, .delete-annotation').length) return;
        clearAnnotationSelection();
    });
});

function handleCanvasError(canvas, pageNum) {
    if (!canvas || !canvas.parentElement) return;
    canvas.style.opacity = '1';
    const existing = canvas.parentElement.querySelector('.pdf-error-overlay');
    if (existing) return;

    const pdfPageUrl = `${WINDOW_BOOK_DATA.pdf_url}#page=${pageNum + 1}`;
    const errorDiv = document.createElement('div');
    errorDiv.className = 'pdf-error-overlay';
    errorDiv.style.cssText = 'position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; text-align: center; background: #fff3cd; color: #856404; font-size: 14px; z-index: 5; padding: 16px;';
    errorDiv.innerHTML = `Failed to render page ${pageNum + 1}<br><small>The browser could not draw this PDF page.</small><a href="${pdfPageUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block; padding:8px 12px; background:#856404; color:#fff; border-radius:6px; text-decoration:none; font-weight:600;">Open original PDF page</a>`;
    canvas.parentElement.appendChild(errorDiv);
}

function toggleMode(mode) {
    if (currentMode === mode) setMode(null);
    else setMode(mode);
}

function setHighlightColor(color) {
    currentHighlightColor = color;
    $('#color-yellow, #color-green, #color-pink, #color-blue').removeClass('ring-2 ring-offset-2 ring-gray-700');
    $(`#color-${color}`).addClass('ring-2 ring-offset-2 ring-gray-700');
}

function setMode(mode) {
    currentMode = mode;
    $('#note-mode-btn').removeClass('text-yellow-600 bg-yellow-100');
    $('#highlight-mode-btn').removeClass('text-yellow-600 bg-yellow-100');
    $('#color-picker').hide();

    if (mode === 'note') {
        $('#note-mode-btn').addClass('text-yellow-600 bg-yellow-100');
        document.body.style.cursor = 'crosshair';
    } else if (mode === 'highlight') {
        $('#highlight-mode-btn').addClass('text-yellow-600 bg-yellow-100');
        $('#color-picker').show();
        document.body.style.cursor = 'text';
    } else {
        document.body.style.cursor = 'default';
    }
}

function deleteNote(id, el) {
    if (!confirm('Delete this note?')) return;
    fetch(`/api/note/${id}`, { method: 'DELETE' })
        .then(r => r.json())
        .then(d => {
            if (d.success) {
                $(el).closest('.note-marker').remove();
                allNotes = allNotes.filter(n => n.id !== id);
            } else {
                alert('Error: ' + (d.error || 'Failed to delete note'));
            }
        })
        .catch(err => {
            console.error('Delete note error:', err);
            alert('Network error: Failed to delete note');
        });
}

function deleteHighlight(id, el) {
    if (!confirm('Remove highlight?')) return;
    fetch(`/api/highlight/${id}`, { method: 'DELETE' })
        .then(r => r.json())
        .then(d => {
            if (d.success) {
                $(el).closest('.highlight-marker').remove();
                allHighlights = allHighlights.filter(h => h.id !== id);
            } else {
                alert('Error: ' + (d.error || 'Failed to delete highlight'));
            }
        })
        .catch(err => {
            console.error('Delete highlight error:', err);
            alert('Network error: Failed to delete highlight');
        });
}

function toggleWarmth() {
    $('body').toggleClass('warm-mode');
}
