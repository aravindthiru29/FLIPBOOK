let currentMode = null; // 'note', 'highlight', or null
let currentHighlightColor = 'yellow';
let allNotes = [];
let allHighlights = [];

// Play page turn sound effect
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
    const PDF_PAGE_COUNT = parseInt(WINDOW_BOOK_DATA.page_count) || 0;
    const BOOK_ID = WINDOW_BOOK_DATA.id;

    // --- PRELOAD DATA ---
    function preloadAnnotations() {
        Promise.all([
            fetch(`/api/book/${BOOK_ID}/notes`).then(r => r.json()),
            fetch(`/api/book/${BOOK_ID}/highlights`).then(r => r.json())
        ]).then(([notes, highlights]) => {
            allNotes = Array.isArray(notes) ? notes : [];
            allHighlights = Array.isArray(highlights) ? highlights : [];
            // Reload current view to show initial annotations
            const currentView = $flipbook.turn('view');
            load(currentView);
        }).catch(err => {
            console.error('Failed to load annotations:', err);
            allNotes = [];
            allHighlights = [];
        });
    }

    // --- ANNOTATION HELPERS ---
    function loadAnnotations(pageNum, $pageEl) {
        // Clear old annotations to avoid duplicates
        $pageEl.find('.note-marker, .highlight-marker').remove();

        // Render from cache
        allNotes.filter(n => n.page_number == pageNum).forEach(n => {
            renderNote(n, $pageEl);
        });
        allHighlights.filter(h => h.page_number == pageNum).forEach(h => {
            renderHighlight(h, $pageEl);
        });
    }

    function renderNote(note, $container) {
        const $layer = $container.find('.annotations-layer');
        const $el = $(`
            <div class="note-marker" style="left:${note.x}%; top:${note.y}%" title="${note.content}">
                <i class="fas fa-sticky-note text-[10px]"></i>
                <div class="delete-annotation" onclick="deleteNote(${note.id}, this); event.stopPropagation();">
                    <i class="fas fa-times"></i>
                </div>
            </div>
        `);
        $el.click((e) => {
            if (currentMode) return;
            alert(`Note: ${note.content}`);
            e.stopPropagation();
        });
        $layer.append($el);
    }

    function renderHighlight(hl, $container) {
        const $layer = $container.find('.annotations-layer');
        const rect = hl.coordinates;
        const colorClass = `highlight-${hl.color || 'yellow'}`;
        const $el = $(`
            <div class="highlight-marker ${colorClass}" style="left:${rect.x}%; top:${rect.y}%; width:${rect.w}%; height:${rect.h}%;">
                <div class="delete-annotation" onclick="deleteHighlight(${hl.id}, this); event.stopPropagation();">
                    <i class="fas fa-times"></i>
                </div>
            </div>
        `);
        $layer.append($el);
    }

    let loaded = new Set();
    function load(view) {
        view.forEach(v => {
            if (v <= 0) return;
            // The .page elements are 0-indexed in jQuery collection, 
            // but Turn.js views are 1-indexed. 
            // In our HTML, page 0 is index 0, page 1 is index 1, etc.
            // Turn.js 'view' for double display returns [pageL, pageR]
            const $p = $flipbook.find(`.page[data-page="${v - 1}"]`);
            if ($p.length === 0) return;

            // Image Lazy Load with error handling
            const $img = $p.find('img');
            if ($img.length && !loaded.has(v)) {
                if ($img.prop('complete')) {
                    $img.css('opacity', 1);
                } else {
                    $img.on('load', function () {
                        $(this).css('opacity', 1);
                    });
                }

                const src = $img.attr('data-src') || $img.attr('src');
                if (src && !$img.attr('src')) {
                    $img.attr('src', src).removeAttr('data-src');

                    // Add error handling for failed image loads
                    $img.on('error', function () {
                        handleImageError(this, v);
                    });
                }
                loaded.add(v);
            }

            // Load annotations for this page
            const pageNum = $p.data('page');
            if (pageNum !== undefined) {
                loadAnnotations(pageNum, $p);
            }
        });
    }

    function preloadPages(currentPage) {
        // Preload next 3 spreads (6 pages)
        const pagesToPreload = [];
        for (let i = 1; i <= 6; i++) {
            const nextP = currentPage + i;
            if (nextP <= PDF_PAGE_COUNT + 2) { // +2 for covers
                pagesToPreload.push(nextP);
            }
        }
        if (pagesToPreload.length > 0) {
            load(pagesToPreload);
        }
    }

    // Initialize Flipbook
    try {
        $flipbook.turn({
            width: 1000,
            height: 700,
            display: 'double',
            autoCenter: true,
            gradients: true,
            elevation: 100,
            duration: 600,
            when: {
                turning: function (e, page, view) {
                    load(view);
                    // Play page turn sound effect immediately when turning starts
                    playPageTurnSound();
                },
                turned: function (e, page, view) {
                    let pdfPages = view.map(v => v - 2).filter(v => v >= 0 && v < PDF_PAGE_COUNT);
                    let displayTxt = "Cover";
                    if (pdfPages.length > 0) {
                        displayTxt = pdfPages.length > 1 ? `${pdfPages[0] + 1} - ${pdfPages[1] + 1}` : `${pdfPages[0] + 1}`;
                    } else if (view.includes($flipbook.turn('pages'))) {
                        displayTxt = "End";
                    }
                    $rangeDisplay.text(displayTxt);

                    // Preload next pages for smoother experience
                    preloadPages(page);
                }
            }
        });
    } catch (e) {
        console.error("Turn.js error:", e);
    }

    // Controls
    $('#prev-btn').click(() => $flipbook.turn("previous"));
    $('#next-btn').click(() => $flipbook.turn("next"));

    $(window).bind('keydown', function (e) {
        if (e.keyCode === 37) $flipbook.turn('previous');
        else if (e.keyCode === 39) $flipbook.turn('next');
    });

    $('#fullscreen-btn').click(() => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
    });

    // Swipe and Mouse Drag Support
    let startX = 0;
    let isDown = false;

    $flipbook.on('touchstart mousedown', (e) => {
        // Ignore if clicking on interactive elements or if in annotation mode
        if ($(e.target).closest('button, .note-marker, .highlight-marker, a, .delete-annotation').length) return;
        if (currentMode) return;

        isDown = true;
        startX = e.type === 'touchstart' ? e.originalEvent.touches[0].clientX : e.pageX;
    });

    $(window).on('touchend mouseup', (e) => {
        if (!isDown) return;
        isDown = false;

        // Handle both touch and mouse events
        let endX;
        if (e.type === 'touchend') {
            endX = e.originalEvent.changedTouches[0].clientX;
        } else {
            endX = e.pageX;
        }

        // Drag threshold
        if (startX - endX > 100) $flipbook.turn('next');      // Drag Left -> Next
        if (endX - startX > 100) $flipbook.turn('previous');  // Drag Right -> Previous
    });

    // --- INTERACTION ---
    let highlightStart = null;
    let $highlightPreview = null;

    $(document).on('click', '.annotations-layer', function (e) {
        if (!currentMode || currentMode === 'highlight') return;

        const $layer = $(this);
        const $page = $layer.closest('.page');
        const pageNum = $page.data('page');

        // Calculate % position relative to layer size
        const offset = $layer.offset();
        const x = ((e.pageX - offset.left) / $layer.width()) * 100;
        const y = ((e.pageY - offset.top) / $layer.height()) * 100;

        if (currentMode === 'note') {
            const content = prompt("Enter note content:");
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
                            renderNote(newNote, $page);
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

    // Swipe Highlighter
    $(document).on('mousedown touchstart', '.annotations-layer', function (e) {
        if (currentMode !== 'highlight') return;
        if ($(e.target).closest('.delete-annotation').length) return;

        e.preventDefault();
        const $layer = $(this);
        const $page = $layer.closest('.page');
        const pageNum = $page.data('page');
        const offset = $layer.offset();

        // Get starting position
        const startClientX = e.type.includes('touch') ? e.originalEvent.touches[0].clientX : e.clientX;
        const startClientY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        const startX = startClientX - offset.left;
        const startY = startClientY - offset.top;

        highlightStart = { x: startX, y: startY, pageNum, $page, $layer, offset };

        // Create preview element with dynamic color
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

        const startX = highlightStart.x;
        const startY = highlightStart.y;

        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

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

        const startX = highlightStart.x;
        const startY = highlightStart.y;

        // Only create highlight if there's meaningful swiping
        if (Math.abs(endX - startX) > 10 || Math.abs(endY - startY) > 10) {
            const left = Math.min(startX, endX);
            const top = Math.min(startY, endY);
            const width = Math.abs(endX - startX);
            const height = Math.abs(endY - startY);

            // Convert to % coordinates
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
                        renderHighlight(newHighlight, $page);
                    } else {
                        alert('Error: ' + (d.error || 'Failed to create highlight'));
                    }
                })
                .catch(err => {
                    console.error('Add highlight error:', err);
                    alert('Network error: Failed to create highlight');
                });
        }

        // Clean up
        $highlightPreview.remove();
        highlightStart = null;
        $highlightPreview = null;
    });

    // Initial load
    setTimeout(() => {
        load($flipbook.turn("view"));
        preloadAnnotations();
    }, 300);
});

// --- GLOBAL HELPERS ---
function handleImageError(img, pageNum) {
    img.style.opacity = '1';
    img.style.backgroundColor = '#fff3cd';
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #fff3cd; color: #856404; font-size: 14px; z-index: 5;';
    errorDiv.innerHTML = `Failed to load page ${pageNum}<br><small>The PDF page may be blank or corrupted</small>`;
    img.parentElement.appendChild(errorDiv);
}

function toggleMode(mode) {
    if (currentMode === mode) setMode(null);
    else setMode(mode);
}

function setHighlightColor(color) {
    currentHighlightColor = color;
    // Update button styling
    $('#color-yellow, #color-green, #color-pink, #color-blue').removeClass('ring-2 ring-offset-2 ring-gray-700');
    $(`#color-${color}`).addClass('ring-2 ring-offset-2 ring-gray-700');
}

function setMode(mode) {
    currentMode = mode;
    // UI Reset
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
    if (!confirm("Delete this note?")) return;
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
    if (!confirm("Remove highlight?")) return;
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
