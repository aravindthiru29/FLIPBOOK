let currentMode = null;
let currentHighlightColor = 'yellow';
let allNotes = [];
let allHighlights = [];

let currentAudioIndex = 0;
let audioUnlocked = false;
function playPageTurnSound() {
    const audioIds = ['page-turn-sound-1', 'page-turn-sound-2'];
    const audio = document.getElementById(audioIds[currentAudioIndex]);
    currentAudioIndex = (currentAudioIndex + 1) % audioIds.length;

    if (audio && audioUnlocked) {
        audio.volume = 1.0;
        audio.currentTime = 0;
        audio.play().catch(() => { });
    }
}

$(document).ready(function () {
    const $flipbook = $('#flipbook');
    const $rangeDisplay = $('#current-pages-range');
    const $loadingPopup = $('#flipbook-loading');
    const $mobileReaderStage = $('#mobile-reader-stage');
    const $mobileCanvas = $('#mobile-page-canvas');
    const $mobilePageIndicator = $('#mobile-page-indicator');
    const PDF_PAGE_COUNT = parseInt(WINDOW_BOOK_DATA.page_count, 10) || 0;
    const BOOK_ID = WINDOW_BOOK_DATA.id;
    const renderedPages = new Set();
    const quickRenderedPages = new Set();
    const renderingPages = new Map();
    let pdfDocumentPromise = null;
    let mobilePageIndex = 0;
    let viewportMode = window.innerWidth < 768 ? 'mobile' : 'desktop';
    let mobileZoom = 1;
    let mobilePanX = 0;
    let mobilePanY = 0;
    let mobileSwipeState = null;
    let mobilePinchState = null;
    const MOBILE_EDGE_SWIPE_ZONE = 56;

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    $(document).one('pointerdown keydown touchstart', () => {
        unlockAudio();
    });

    function getPdfDocument() {
        if (!pdfDocumentPromise) {
            pdfDocumentPromise = pdfjsLib.getDocument(WINDOW_BOOK_DATA.pdf_url).promise;
        }
        return pdfDocumentPromise;
    }

    function hideLoadingPopup() {
        $loadingPopup.addClass('is-hidden');
    }

    function showLoadingPopup(message) {
        if (message) {
            $loadingPopup.find('.loading-copy p').text(message);
        }
        $loadingPopup.removeClass('is-hidden');
    }

    function unlockAudio() {
        if (audioUnlocked) return;
        const audioIds = ['page-turn-sound-1', 'page-turn-sound-2'];
        audioIds.forEach((audioId) => {
            const audio = document.getElementById(audioId);
            if (!audio) return;
            audio.muted = true;
            audio.play()
                .then(() => {
                    audio.pause();
                    audio.currentTime = 0;
                    audio.muted = false;
                    audioUnlocked = true;
                })
                .catch(() => { });
        });
    }

    function isMobileViewport() {
        return window.innerWidth <= 768 || (window.innerHeight < 500 && window.innerWidth < 950);
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function updateZoomLabel() {
        $('#mobile-zoom-reset-btn').text(`${Math.round(mobileZoom * 100)}%`);
    }

    function setMobileSwipeVisual(progress = 0, direction = 1) {
        const normalizedProgress = clamp(progress, 0, 1);
        const normalizedDirection = direction >= 0 ? 1 : -1;
        $mobileReaderStage.css('--mobile-swipe-progress', normalizedProgress.toFixed(3));
        $mobileReaderStage.css('--mobile-swipe-direction', normalizedDirection.toString());
    }

    function updateMobilePageIndicator() {
        if ($mobilePageIndicator.length) {
            $mobilePageIndicator.text(`${mobilePageIndex + 1} / ${PDF_PAGE_COUNT}`);
        }
    }

    function applyMobileTransform(options = {}) {
        const animate = options.animate === true;
        const swipeOffsetX = options.swipeOffsetX || 0;
        if (!$mobileCanvas.length) return;

        const swipeProgress = Math.abs(swipeOffsetX) / Math.max($mobileReaderStage.innerWidth() || 1, 1);
        const swipeDirection = swipeOffsetX >= 0 ? 1 : -1;
        const translatedX = mobilePanX + swipeOffsetX;
        const scale = mobileZoom > 1.02 ? mobileZoom : mobileZoom - Math.min(swipeProgress * 0.012, 0.012);

        $mobileReaderStage.toggleClass('is-animating', animate);
        $mobileReaderStage.toggleClass('is-swiping', !animate && swipeOffsetX !== 0);
        setMobileSwipeVisual(swipeProgress, swipeOffsetX || 1);
        $mobileCanvas.css(
            'transform',
            `translate3d(${translatedX}px, ${mobilePanY}px, 0) scale(${scale})`
        );
        if (mobileZoom <= 1.02) {
            $mobileCanvas.css('opacity', `${1 - Math.min(swipeProgress * 0.22, 0.22)}`);
        }
        updateZoomLabel();
    }

    function resetMobileZoom(options = {}) {
        mobileZoom = 1;
        mobilePanX = 0;
        mobilePanY = 0;
        applyMobileTransform(options);
    }

    function setMobileZoom(nextZoom, options = {}) {
        mobileZoom = clamp(nextZoom, 1, 3);
        if (mobileZoom === 1) {
            mobilePanX = 0;
            mobilePanY = 0;
        } else {
            mobilePanX = clamp(mobilePanX, -120 * (mobileZoom - 1), 120 * (mobileZoom - 1));
            mobilePanY = clamp(mobilePanY, -180 * (mobileZoom - 1), 180 * (mobileZoom - 1));
        }
        applyMobileTransform(options);
    }

    function getTouchDistance(touchA, touchB) {
        return Math.hypot(touchA.clientX - touchB.clientX, touchA.clientY - touchB.clientY);
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
                ${WINDOW_BOOK_DATA.can_annotate ? `
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
                ${WINDOW_BOOK_DATA.can_annotate ? `
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

    function getMobileViewportForPage(page) {
        const baseViewport = page.getViewport({ scale: 1 });
        const containerWidth = $mobileReaderStage.innerWidth() || (window.innerWidth * 0.88);
        const containerHeight = $mobileReaderStage.innerHeight() || (window.innerHeight * 0.72);
        const fitScale = Math.min(
            containerWidth / baseViewport.width,
            containerHeight / baseViewport.height
        );
        const deviceScale = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: Math.max(fitScale, 0.1) * deviceScale });

        return { viewport, qualityScale: deviceScale };
    }

    function updateMobileNavState() {
        $('#mobile-prev-btn').prop('disabled', mobilePageIndex <= 0);
        $('#mobile-next-btn').prop('disabled', mobilePageIndex >= PDF_PAGE_COUNT - 1);
    }

    async function renderMobilePage(pageNum) {
        const canvas = $mobileCanvas.get(0);
        if (!canvas || pageNum < 0 || pageNum >= PDF_PAGE_COUNT) {
            return;
        }

        try {
            const pdf = await getPdfDocument();
            const page = await pdf.getPage(pageNum + 1);
            const { viewport, qualityScale } = getMobileViewportForPage(page);
            const context = canvas.getContext('2d', { alpha: false });

            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            canvas.style.width = `${Math.floor(viewport.width / qualityScale)}px`;
            canvas.style.height = `${Math.floor(viewport.height / qualityScale)}px`;

            await page.render({ canvasContext: context, viewport }).promise;
            canvas.style.opacity = '1';
            mobilePageIndex = pageNum;
            $rangeDisplay.text(`${pageNum + 1}`);
            updateMobilePageIndicator();
            updateMobileNavState();
            resetMobileZoom({ animate: false });
            hideLoadingPopup();
        } catch (error) {
            console.error(`Mobile PDF render failed for page ${pageNum + 1}:`, error);
            showLoadingPopup('The PDF could not be loaded. Please refresh or open the original file.');
        }
    }

    async function animateMobilePageTurn(direction) {
        if (direction !== 1 && direction !== -1) return;
        const targetPage = mobilePageIndex + direction;
        if (targetPage < 0 || targetPage >= PDF_PAGE_COUNT) return;

        playPageTurnSound();
        $mobileReaderStage.removeClass('is-swiping').addClass('is-animating');
        setMobileSwipeVisual(0.34, direction);
        $mobileCanvas.css({
            transform: `translate3d(${direction * -68}px, 0, 0) scale(0.988)`,
            opacity: '0.42'
        });

        window.setTimeout(async () => {
            await renderMobilePage(targetPage);
            setMobileSwipeVisual(0.22, -direction);
            $mobileCanvas.css({
                transform: `translate3d(${direction * 28}px, 0, 0) scale(0.996)`,
                opacity: '0.82'
            });
            requestAnimationFrame(() => {
                applyMobileTransform({ animate: true });
                $mobileCanvas.css('opacity', '1');
            });
            window.setTimeout(() => {
                $mobileReaderStage.removeClass('is-animating');
                setMobileSwipeVisual(0, 1);
            }, 230);
        }, 150);
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

        hideLoadingPopup();
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
        const isMobile = isMobileViewport();

        if (isMobile) {
            const maxWidth = width * 0.92;
            const maxHeight = height * 0.76;
            const portraitRatio = 0.72;
            let w = Math.min(maxWidth, maxHeight * portraitRatio);
            let h = w / portraitRatio;

            if (h > maxHeight) {
                h = maxHeight;
                w = h * portraitRatio;
            }

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

        if (isMobileViewport()) {
            debouncedLoad($flipbook.turn('view'));
        }
    } catch (e) {
        console.error('Turn.js error:', e);
    }

    $(window).resize(_.debounce(function () {
        const nextMode = isMobileViewport() ? 'mobile' : 'desktop';
        if (nextMode !== viewportMode) {
            window.location.reload();
            return;
        }
        resizeFlipbook();
    }, 150));

    $('#prev-btn').click(() => $flipbook.turn('previous'));
    $('#next-btn').click(() => $flipbook.turn('next'));
    $('#mobile-prev-btn').click(() => {
        unlockAudio();
        $flipbook.turn('previous');
    });
    $('#mobile-next-btn').click(() => {
        unlockAudio();
        $flipbook.turn('next');
    });
    $('#mobile-zoom-in-btn').click(() => setMobileZoom(mobileZoom + 0.2, { animate: true }));
    $('#mobile-zoom-out-btn').click(() => setMobileZoom(mobileZoom - 0.2, { animate: true }));
    $('#mobile-zoom-reset-btn').click(() => resetMobileZoom({ animate: true }));

    let isWheeling = false;
    $(window).on('wheel', function (e) {
        if (isMobileViewport() || isWheeling) return;
        if (currentMode) return;

        const deltaX = e.originalEvent.deltaX;

        if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(e.originalEvent.deltaY)) {
            isWheeling = true;
            if (deltaX > 0) {
                $flipbook.turn('next');
            } else {
                $flipbook.turn('previous');
            }
            setTimeout(() => { isWheeling = false; }, 600);
        }
    });

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
                if (isMobileViewport()) {
                    renderMobilePage(mobilePageIndex);
                } else {
                    const currentView = $flipbook.turn('view');
                    load(currentView);
                    window.setTimeout(preloadAnnotations, 150);
                    window.setTimeout(() => {
                        const lastPage = Math.max(...currentView);
                        preloadPages(lastPage);
                    }, 80);
                }
            })
            .catch(error => {
                console.error('PDF document load failed:', error);
                showLoadingPopup('The PDF could not be loaded. Please refresh or open the original file.');
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
    $('#color-picker').addClass('hidden');

    if (mode === 'note') {
        $('#note-mode-btn').addClass('text-yellow-600 bg-yellow-100');
        document.body.style.cursor = 'crosshair';
    } else if (mode === 'highlight') {
        $('#highlight-mode-btn').addClass('text-yellow-600 bg-yellow-100');
        $('#color-picker').removeClass('hidden');
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
