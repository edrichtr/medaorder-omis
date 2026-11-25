const $ = id => document.getElementById(id);
let allProducts = [];
let selectedProductIds = new Set();
let currentEventImageData = "";

export function initializeEventStudio(config, products) {
    allProducts = products;
    if (config) {
        populateFormFromConfig(config);
        renderProductsPicker();
        window.syncPreview();
    } else {
        currentEventImageData = '';
        window.applyEventPreset('autumn', false);
    }
    $('eventEditor').hidden = false;
    $('eventLoadStatus').hidden = true;
}

export function updateEventProducts(products) {
    allProducts = products;
    if (!$('eventEditor').hidden) {
        renderProductsPicker();
        window.syncPreview();
    }
}

function populateFormFromConfig(cfg = {}) {
    $('evBannerActive').checked = cfg.isActive !== false;
    $('evSectionActive').checked = cfg.sectionActive === true;
    $('evPopupActive').checked = cfg.popupActive === true;
    $('evCountdownActive').checked = cfg.countdownEnabled === true;

    $('evBadgeText').value = cfg.badgeText || 'HOT';
    $('evTitle').value = cfg.title || 'Tuần Lễ Chữa Lành Mê Đá';
    $('evDesc').value = cfg.desc || 'Giảm 20% cho mọi đơn hàng trà & cà phê đặc sản hôm nay!';
    $('evBannerCta').value = cfg.bannerCta || 'Khám phá ngay ↓';
    $('evBgColor').value = cfg.bgColor || '#C85A32';
    $('evTextColor').value = cfg.textColor || '#FFFFFF';

    $('evThemeStyle').value = cfg.themeStyle || 'warm-terracotta';
    $('evAmbientEffect').value = cfg.ambientEffect || 'default';
    $('evSectionTag').value = cfg.sectionTag || '✨ SỰ KIỆN ĐẶC BIỆT TẠI MÊ ĐÁ';
    $('evOfferHighlight').value = cfg.offerHighlight || 'ƯU ĐÃI ĐẶC BIỆT';
    $('evSectionTitle').value = cfg.sectionTitle || cfg.title || 'Trạm Dừng Chân Chữa Lành Giữa Phố Thị';
    $('evSectionSubtitle').value = cfg.sectionSubtitle || cfg.desc || 'Hãy tự thưởng cho mình một khoảng lặng dịu dàng bên ly đồ uống thơm lừng tại Mê Đá.';
    $('evPromoCode').value = cfg.promoCode || '';
    $('evCountdownEnd').value = cfg.countdownEnd || getDefaultFutureDateStr(3);
    $('evSectionCtaText').value = cfg.sectionCtaText || 'Thưởng Thức Ngay ↓';

    currentEventImageData = cfg.sectionImage || '';
    $('evImageUrlInput').value = (currentEventImageData && !currentEventImageData.startsWith('data:')) ? currentEventImageData : '';

    const perks = Array.isArray(cfg.highlights) ? cfg.highlights : [];
    $('evPerk1Title').value = perks[0]?.title || '🎁 Ưu đãi trực tiếp';
    $('evPerk1Desc').value = perks[0]?.desc || 'Áp dụng cho cả khách dùng tại quán & mang về';
    $('evPerk2Title').value = perks[1]?.title || '🍃 Nguyên liệu tươi mới';
    $('evPerk2Desc').value = perks[1]?.desc || 'Pha chế thủ công chuẩn vị Mê Đá mỗi ngày';
    $('evPerk3Title').value = perks[2]?.title || '🐢 Không gian chữa lành';
    $('evPerk3Desc').value = perks[2]?.desc || 'Góc nhỏ bình yên giữa lòng phố thị xô bồ';

    selectedProductIds = new Set(Array.isArray(cfg.featuredProductIds) ? cfg.featuredProductIds : []);

    $('evPopupBadge').value = cfg.popupBadge || '🎁 QUÀ TẶNG TỪ MÊ ĐÁ';
    $('evPopupTitle').value = cfg.popupTitle || cfg.sectionTitle || 'Chào mừng bạn đến với Mê Đá!';
    $('evPopupContent').value = cfg.popupContent || cfg.sectionSubtitle || 'Đừng bỏ lỡ chương trình ưu đãi đặc biệt đang diễn ra hôm nay nhé!';
    $('evPopupCtaText').value = cfg.popupCtaText || 'Nhận Ưu Đãi & Xem Menu Ngay';
    $('evPopupFrequency').value = cfg.popupFrequency || 'once_session';
}

function getDefaultFutureDateStr(daysAhead = 3) {
    const d = new Date(Date.now() + daysAhead * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T22:00`;
}

function createProductItem(product, selectable) {
    const item = document.createElement(selectable ? 'label' : 'div');
    item.className = selectable ? 'prod-pick-item' : 'featured-product';
    if (selectable) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = product.id;
        checkbox.checked = selectedProductIds.has(product.id);
        checkbox.onchange = () => {
            if (checkbox.checked) selectedProductIds.add(product.id);
            else selectedProductIds.delete(product.id);
            updateSelectionCount();
            window.syncPreview();
        };
        item.append(checkbox);
    }
    const image = document.createElement('img');
    image.alt = '';
    image.addEventListener('error', () => { image.src = 'logo.jpg'; }, { once: true });
    image.src = product.image || 'logo.jpg';
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = product.name;
    const price = document.createElement('span');
    price.textContent = Number(product.price || 0).toLocaleString('vi-VN') + 'đ';
    details.append(name, price);
    item.append(image, details);
    return item;
}

function updateSelectionCount() {
    $('selectedProductsCount').textContent = 'Đã chọn ' + selectedProductIds.size + ' món';
}

function renderProductsPicker() {
    const box = $('featuredProductsPicker');
    updateSelectionCount();
    if (allProducts.length) {
        box.replaceChildren(...allProducts.map(product => createProductItem(product, true)));
    } else {
        box.textContent = 'Chưa có sản phẩm nào trong thực đơn.';
    }
}

// 3. Xử lý tải ảnh sự kiện (Nén tự động qua Canvas)
window.handleEventImageUpload = function(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            const maxW = 900;
            if (w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            currentEventImageData = canvas.toDataURL('image/jpeg', 0.78);
            $('evImageUrlInput').value = '';
            window.syncPreview();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
};

window.handleEventImageUrlInput = function() {
    const url = ($('evImageUrlInput').value || '').trim();
    currentEventImageData = url;
    window.syncPreview();
};

window.clearEventImage = function() {
    currentEventImageData = "";
    $('evImageFile').value = "";
    $('evImageUrlInput').value = "";
    window.syncPreview();
};

// 4. Kho mẫu sự kiện 1-Click
const EVENT_PRESETS = {
    autumn: {
        isActive: true, sectionActive: true, popupActive: true, countdownEnabled: true,
        badgeText: 'THU CHỮA LÀNH',
        title: 'Trạm Dừng Chân Mùa Thu - Chữa Lành Giữa Phố Thị',
        desc: 'Ưu đãi 15% dòng Trà Ô Long & Cà Phê Kem Đặc Sản suốt tuần lễ mùa thu',
        bannerCta: 'Khám phá ưu đãi ↓',
        bgColor: '#C85A32', textColor: '#FFFFFF',
        themeStyle: 'warm-terracotta', ambientEffect: 'default',
        sectionTag: '🍂 CHIẾN DỊCH MÙA THU MÊ ĐÁ',
        offerHighlight: 'GIẢM 15% + TẶNG BÁNH QUY',
        sectionTitle: 'Chậm Lại Một Nhịp... Thưởng Thức Mùa Thu Tại Mê Đá',
        sectionSubtitle: 'Giữa những ngày bận rộn, hãy ghé Mê Đá nhâm nhi một ly trà ấm áp, lắng nghe tiếng nhạc dịu êm và nhận ngay ưu đãi mùa thu dành riêng cho bạn.',
        promoCode: 'THUMEDA15',
        sectionCtaText: 'Đặt Món Mùa Thu Ngay ↓',
        highlights: [
            { title: '🍂 Giảm 15% Menu Thu', desc: 'Áp dụng khi nhập hoặc đọc mã THUMEDA15 tại quầy' },
            { title: '🍪 Tặng Bánh Quy Bơ', desc: 'Cho mọi hóa đơn từ 2 ly đồ uống bất kỳ' },
            { title: '🐢 Check-in Cùng Cụ Rùa', desc: 'Không gian thư giãn, ấm cúng cho ngày dịu mát' }
        ],
        popupBadge: '🍂 MÙA THU CHỮA LÀNH',
        popupTitle: 'Ghé Mê Đá Nhận Quà Mùa Thu Nhé!',
        popupContent: 'Chào bạn! Mê Đá dành tặng bạn ưu đãi giảm 15% kèm bánh quy bơ thơm lừng trong tuần lễ Mùa Thu Chữa Lành.',
        popupCtaText: 'Nhận Ưu Đãi & Chọn Món Ngay'
    },
    student: {
        isActive: true, sectionActive: true, popupActive: true, countdownEnabled: true,
        badgeText: 'SINH VIÊN',
        title: 'Tuần Lễ Học Sinh - Sinh Viên: Đi Nhóm Càng Đông, Giá Càng Rẻ!',
        desc: 'Mua 2 Tặng 1 toàn bộ Trà Sữa & Trà Trái Cây từ 13h00 - 17h00 hằng ngày',
        bannerCta: 'Săn Deal Nhóm ↓',
        bgColor: '#1565C0', textColor: '#FFFFFF',
        themeStyle: 'forest-healing', ambientEffect: 'sparkles',
        sectionTag: '🎓 TUẦN LỄ SINH VIÊN SÔI ĐỘNG',
        offerHighlight: 'MUA 2 TẶNG 1 · FREE UP SIZE',
        sectionTitle: 'Học Hết Sức - Chill Hết Mình Cùng Hội Bạn Thân!',
        sectionSubtitle: 'Chỉ cần rủ hội bạn cùng đặt món tại Mê Đá, nhận ngay ưu đãi Mua 2 Tặng 1 cực hời và miễn phí nâng size ly lớn.',
        promoCode: 'MEDASV',
        sectionCtaText: 'Chọn Món Cho Nhóm Ngay ↓',
        highlights: [
            { title: '🧋 Mua 2 Tặng 1', desc: 'Tặng ngay 1 ly trà trái cây tươi mát cho đơn từ 2 ly' },
            { title: '⚡ Free Nâng Size L', desc: 'Thêm năng lượng chạy deadline không lo về giá' },
            { title: '🔌 Wifi Tốc Độ Cao', desc: 'Ổ cắm điện tại mọi bàn, điều hòa mát lạnh' }
        ],
        popupBadge: '🎓 DEAL ĐỘC QUYỀN SINH VIÊN',
        popupTitle: 'Mua 2 Tặng 1 Hôm Nay Tại Mê Đá!',
        popupContent: 'Rủ bạn bè đặt đơn ngay để nhận ưu đãi Mua 2 Tặng 1 và miễn phí nâng size trong Tuần Lễ Sinh Viên!',
        popupCtaText: 'Săn Deal Sinh Viên Ngay'
    },
    acoustic: {
        isActive: true, sectionActive: true, popupActive: true, countdownEnabled: true,
        badgeText: 'ACOUSTIC NIGHT',
        title: 'Đêm Nhạc Acoustic "Những Bản Tình Ca Chữa Lành" - Tối Thứ 7',
        desc: 'Phụ thu 0đ · Tặng kèm nến thơm & trà nóng cho khách đặt trước',
        bannerCta: 'Xem Lịch Đêm Nhạc ↓',
        bgColor: '#28304E', textColor: '#FFFFFF',
        themeStyle: 'night-acoustic', ambientEffect: 'sparkles',
        sectionTag: '🌙 ĐÊM NHẠC ACOUSTIC CUỐI TUẦN',
        offerHighlight: 'PHỤ THU 0Đ · ĐẶT MÓN TRƯỚC',
        sectionTitle: 'Lắng Nghe Giai Điệu Mộc Mạc Bên Ly Đồ Uống Ấm Nồng',
        sectionSubtitle: 'Một buổi tối nhẹ nhàng với tiếng đàn guitar mộc, ánh đèn vàng ấm áp và những thức uống đặc trưng chỉ có tại Mê Đá.',
        promoCode: 'ACOUSTIC',
        sectionCtaText: 'Chọn Đồ Uống Cho Đêm Nhạc ↓',
        highlights: [
            { title: '🎸 Live Acoustic 19h30', desc: 'Giao lưu âm nhạc mộc mạc, chữa lành tâm hồn' },
            { title: '🕯 Không Phụ Thu Vé', desc: 'Chỉ cần gọi món nước yêu thích trên thực đơn' },
            { title: '🍵 Menu Đồ Ấm Đặc Biệt', desc: 'Cacao nóng, Trà gừng mật ong & Latte nghệ thuật' }
        ],
        popupBadge: '🌙 ĐÊM NHẠC ACOUSTIC',
        popupTitle: 'Hẹn Nhau Đêm Nhạc Chữa Lành Tại Mê Đá!',
        popupContent: 'Đặt trước đồ uống yêu thích của bạn và cùng Mê Đá đắm mình trong không gian âm nhạc Acoustic ấm áp tối nay.',
        popupCtaText: 'Khám Phá Menu Đêm Nhạc'
    },
    tet: {
        isActive: true, sectionActive: true, popupActive: true, countdownEnabled: true,
        badgeText: 'LỘC XUÂN',
        title: 'Khai Xuân Như Ý - Hái Lộc Đầu Năm Cùng Mê Đá',
        desc: 'Tặng bao lì xì may mắn cho 100% đơn hàng & bộ sưu tập đồ uống Tết Đoàn Viên',
        bannerCta: 'Hái Lộc Ngay ↓',
        bgColor: '#B71C1C', textColor: '#FFF8E1',
        themeStyle: 'festive-crimson', ambientEffect: 'sakura',
        sectionTag: '🌸 XUÂN ĐOÀN VIÊN · VẠN SỰ NHƯ Ý',
        offerHighlight: '100% TRÚNG LÌ XÌ MAY MẮN',
        sectionTitle: 'Trao Vị Ngọt Lành - Đón Xuân An Khang Cùng Mê Đá',
        sectionSubtitle: 'Mừng xuân mới, Mê Đá ra mắt bộ sưu tập thức uống thanh mát kết hợp nguyên liệu truyền thống cùng lì xì đầu năm cho mọi khách hàng.',
        promoCode: 'LOCXUAN88',
        sectionCtaText: 'Đặt Món Hái Lộc Ngay ↓',
        highlights: [
            { title: '🧧 Lì Xì 100% Đơn Hàng', desc: 'Mỗi đơn hàng nhận ngay 1 phong bao lì xì may mắn' },
            { title: '🌸 Menu Xuân Đặc Biệt', desc: 'Hương vị hoa quả tươi mát, ngọt lành đầu năm' },
            { title: '📸 Góc Check-in Tết', desc: 'Không gian trang trí rực rỡ sắc xuân truyền thống' }
        ],
        popupBadge: '🌸 MỪNG XUÂN MỚI MÊ ĐÁ',
        popupTitle: 'Khai Xuân Lộc Phát - Nhận Lì Xì Ngay!',
        popupContent: 'Chúc mừng năm mới! Mê Đá gửi tặng bạn mã ưu đãi LOCXUAN88 và lì xì may mắn khi đặt món hôm nay.',
        popupCtaText: 'Hái Lộc & Đặt Món Ngay'
    },
    christmas: {
        isActive: true, sectionActive: true, popupActive: true, countdownEnabled: true,
        badgeText: 'MERRY XMAS',
        title: 'Giáng Sinh Ấm Áp Tại Mê Đá - Tuyết Rơi Giữa Lòng Phố',
        desc: 'Thưởng thức Cacao Kem Tuyết & Trà Quế Mật Ong ấm sực mùa lễ hội',
        bannerCta: 'Đón Giáng Sinh ↓',
        bgColor: '#1B5E20', textColor: '#FFFFFF',
        themeStyle: 'forest-healing', ambientEffect: 'snow',
        sectionTag: '🎄 MÙA LỄ HỘI GIÁNG SINH AN LÀNH',
        offerHighlight: 'COMBO GIÁNG SINH CHỈ 59K',
        sectionTitle: 'Giáng Sinh Dịu Êm Bên Ly Cacao Nóng & Ánh Đèn Thông',
        sectionSubtitle: 'Cảm nhận không khí lễ hội ngập tràn với hiệu ứng tuyết rơi lãng mạn và những món đồ uống mùa đông ngọt ngào tại Mê Đá.',
        promoCode: 'XMASMEDA',
        sectionCtaText: 'Chọn Món Giáng Sinh ↓',
        highlights: [
            { title: '❄️ Không Gian Tuyết Rơi', desc: 'Trải nghiệm mùa đông lung linh ngay tại quán' },
            { title: '☕ Đồ Uống Kem Tuyết', desc: 'Lớp kem béo mịn phủ bột cacao thượng hạng' },
            { title: '🎁 Thiệp Chúc Viết Tay', desc: 'Gửi gắm lời chúc ấm áp trên từng ly nước' }
        ],
        popupBadge: '🎄 GIÁNG SINH AN LÀNH',
        popupTitle: 'Mùa Lễ Hội Đã Về Trên Mê Đá!',
        popupContent: 'Cùng thưởng thức bộ sưu tập đồ uống mùa lễ hội và nhận ngay ưu đãi Giáng Sinh ấm áp hôm nay.',
        popupCtaText: 'Khám Phá Menu Giáng Sinh'
    },
    flashsale: {
        isActive: true, sectionActive: true, popupActive: true, countdownEnabled: true,
        badgeText: 'FLASH SALE',
        title: '⚡ GIỜ VÀNG GIÁ SỐC: Đồng Giá 25.000đ Các Món Best-Seller!',
        desc: 'Số lượng có hạn trong khung giờ vàng hôm nay - Đặt ngay kẻo lỡ!',
        bannerCta: 'Chốt Đơn Ngay ↓',
        bgColor: '#D84315', textColor: '#FFFFFF',
        themeStyle: 'royal-gold', ambientEffect: 'hearts',
        sectionTag: '⚡ FLASH SALE KHUNG GIỜ VÀNG',
        offerHighlight: 'ĐỒNG GIÁ 25K · SỐ LƯỢNG CÓ HẠN',
        sectionTitle: 'Săn Deal Giờ Vàng - Thưởng Thức Best-Seller Giá Siêu Hời!',
        sectionSubtitle: 'Chương trình ưu đãi chớp nhoáng dành cho các tín đồ của Mê Đá. Đặt trực tiếp trên website và thanh toán QR chỉ trong 1 chạm!',
        promoCode: 'FLASH25K',
        sectionCtaText: 'Săn Deal 25K Ngay ↓',
        highlights: [
            { title: '🔥 Giá Sốc Trong Ngày', desc: 'Áp dụng cho danh sách món nổi bật bên dưới' },
            { title: '⚡ Pha Chế Siêu Tốc', desc: 'Đồng bộ thẳng xuống Quầy Bếp không cần chờ đợi' },
            { title: '💳 Thanh Toán VietQR', desc: 'Quét mã tự động điền số tiền trong 3 giây' }
        ],
        popupBadge: '⚡ FLASH SALE GIỜ VÀNG',
        popupTitle: 'Đang Diễn Ra Flash Sale Tại Mê Đá!',
        popupContent: 'Nhanh tay đặt ngay các món Best-Seller với mức giá ưu đãi đặc biệt trước khi đồng hồ đếm ngược kết thúc!',
        popupCtaText: 'Săn Flash Sale Ngay'
    }
};

window.applyEventPreset = function(key, showNotice = true) {
    const p = EVENT_PRESETS[key];
    if (!p) return;
    populateFormFromConfig({
        ...p,
        countdownEnd: getDefaultFutureDateStr(2),
        featuredProductIds: allProducts.slice(0, 3).map(x => x.id),
        sectionImage: currentEventImageData
    });
    renderProductsPicker();
    window.syncPreview();
    if (showNotice) {
        alert(`✨ Đã nạp mẫu sự kiện "${p.title}"! Bạn có thể tinh chỉnh thêm hoặc bấm "🚀 Xuất Bản Lên Trang Chủ" ngay.`);
    }
};

// 5. Đồng bộ Form sang Khung Xem Trước (Live Preview)
export function buildCurrentConfigObject() {
    const highlights = [
        { title: ($('evPerk1Title').value || '').trim(), desc: ($('evPerk1Desc').value || '').trim() },
        { title: ($('evPerk2Title').value || '').trim(), desc: ($('evPerk2Desc').value || '').trim() },
        { title: ($('evPerk3Title').value || '').trim(), desc: ($('evPerk3Desc').value || '').trim() }
    ].filter(h => h.title || h.desc);

    return {
        isActive: $('evBannerActive').checked,
        sectionActive: $('evSectionActive').checked,
        popupActive: $('evPopupActive').checked,
        countdownEnabled: $('evCountdownActive').checked,

        badgeText: ($('evBadgeText').value || 'HOT').trim(),
        title: ($('evTitle').value || '').trim(),
        desc: ($('evDesc').value || '').trim(),
        bannerCta: ($('evBannerCta').value || '').trim(),
        bgColor: $('evBgColor').value || '#C85A32',
        textColor: $('evTextColor').value || '#FFFFFF',

        themeStyle: $('evThemeStyle').value || 'warm-terracotta',
        ambientEffect: $('evAmbientEffect').value || 'default',
        sectionTag: ($('evSectionTag').value || '').trim(),
        offerHighlight: ($('evOfferHighlight').value || '').trim(),
        sectionTitle: ($('evSectionTitle').value || '').trim(),
        sectionSubtitle: ($('evSectionSubtitle').value || '').trim(),
        promoCode: ($('evPromoCode').value || '').trim().toUpperCase(),
        countdownEnd: $('evCountdownEnd').value || '',
        sectionCtaText: ($('evSectionCtaText').value || 'Thưởng Thức Ngay ↓').trim(),
        sectionImage: currentEventImageData || '',
        highlights,
        featuredProductIds: Array.from(selectedProductIds),

        popupBadge: ($('evPopupBadge').value || '').trim(),
        popupTitle: ($('evPopupTitle').value || '').trim(),
        popupContent: ($('evPopupContent').value || '').trim(),
        popupCtaText: ($('evPopupCtaText').value || 'Nhận Ưu Đãi Ngay').trim(),
        popupFrequency: $('evPopupFrequency').value || 'once_session',
        updatedAt: Date.now()
    };
}

window.syncPreview = function() {
    const cfg = buildCurrentConfigObject();

    // Cập nhật 4 ô trạng thái
    const setTile = (tileId, statusId, on) => {
        $(tileId).classList.toggle('active-tile', on);
        $(statusId).textContent = on ? '🟢 Đang bật' : '⚪ Đang tắt';
        $(statusId).style.color = on ? 'var(--green)' : 'var(--text-muted)';
    };
    setTile('tileBanner', 'tileBannerStatus', cfg.isActive);
    setTile('tileSection', 'tileSectionStatus', cfg.sectionActive);
    setTile('tilePopup', 'tilePopupStatus', cfg.popupActive);
    setTile('tileCountdown', 'tileCountdownStatus', cfg.countdownEnabled);

    const ambientNames = {
        default: '🍃 Lá thu rơi',
        sakura: '🌸 Hoa đào rơi',
        snow: '❄️ Tuyết mùa đông',
        sparkles: '✨ Đom đóm lấp lánh',
        hearts: '🧡 Trái tim chữa lành'
    };
    $('prvAmbientLabel').textContent = ambientNames[cfg.ambientEffect] || '🍃 Lá thu rơi';

    // 1. Preview Banner
    const bannerBox = $('prvBannerBox');
    bannerBox.style.display = cfg.isActive ? 'flex' : 'none';
    bannerBox.style.backgroundColor = cfg.bgColor;
    bannerBox.style.color = cfg.textColor;
    $('prvBadge').textContent = cfg.badgeText || 'HOT';
    $('prvBannerTitle').textContent = cfg.title || 'Sự Kiện';
    $('prvBannerDesc').textContent = cfg.desc || '';
    $('prvBannerCta').style.display = cfg.bannerCta ? 'inline-block' : 'none';
    $('prvBannerCta').textContent = cfg.bannerCta;

    // 2. Preview Section
    const secWrap = $('prvSectionWrap');
    secWrap.style.display = cfg.sectionActive ? 'block' : 'none';
    const card = $('prvEventCard');
    card.className = `prv-event-card theme-${cfg.themeStyle}`;

    $('prvSectionTag').textContent = cfg.sectionTag || '✨ SỰ KIỆN ĐẶC BIỆT';
    $('prvOfferHighlight').style.display = cfg.offerHighlight ? 'inline-flex' : 'none';
    $('prvOfferHighlight').textContent = cfg.offerHighlight;
    $('prvSectionTitle').textContent = cfg.sectionTitle || 'Tiêu đề sự kiện';
    $('prvSectionSubtitle').textContent = cfg.sectionSubtitle || '';

    $('prvVoucherWrap').style.display = cfg.promoCode ? 'inline-flex' : 'none';
    $('prvPromoCode').textContent = cfg.promoCode;

    $('prvCountdownWrap').style.display = cfg.countdownEnabled ? 'flex' : 'none';

    const imgEl = $('prvEventImg');
    if (cfg.sectionImage) {
        imgEl.src = cfg.sectionImage;
        imgEl.style.display = 'block';
    } else {
        imgEl.style.display = 'none';
    }

    const perksGrid = $('prvPerksGrid');
    if (cfg.highlights.length > 0) {
        perksGrid.style.display = 'grid';
        perksGrid.replaceChildren(...cfg.highlights.map(highlight => {
            const perk = document.createElement('div');
            perk.className = 'prv-perk-card';
            const title = document.createElement('strong');
            title.textContent = highlight.title;
            const desc = document.createElement('span');
            desc.textContent = highlight.desc;
            perk.append(title, desc);
            return perk;
        }));
    } else {
        perksGrid.style.display = 'none';
    }

    const featProducts = allProducts.filter(p => selectedProductIds.has(p.id));
    const featWrap = $('prvFeaturedDrinksWrap');
    const featList = $('prvFeaturedDrinksList');
    if (featProducts.length > 0) {
        featWrap.style.display = 'block';
        featList.replaceChildren(...featProducts.map(product => createProductItem(product, false)));
    } else {
        featWrap.style.display = 'none';
    }

    $('prvSectionCtaBtn').textContent = cfg.sectionCtaText || 'Thưởng Thức Ngay ↓';

    // 3. Preview Popup
    $('prvPopupBadge').textContent = cfg.popupBadge || '🎁 QUÀ TẶNG ĐẶC BIỆT';
    $('prvPopupTitle').textContent = cfg.popupTitle || cfg.sectionTitle || 'Chào mừng đến với Mê Đá!';
    $('prvPopupContent').textContent = cfg.popupContent || cfg.sectionSubtitle || '';
    $('prvPopupCtaBtn').textContent = cfg.popupCtaText || 'Nhận Ưu Đãi Ngay';
    if (cfg.promoCode) {
        $('prvPopupVoucherBox').style.display = 'block';
        $('prvPopupVoucherCode').textContent = cfg.promoCode;
    } else {
        $('prvPopupVoucherBox').style.display = 'none';
    }
    if (cfg.sectionImage) {
        $('prvPopupImg').src = cfg.sectionImage;
        $('prvPopupImg').style.display = 'block';
    } else {
        $('prvPopupImg').style.display = 'none';
    }
};

window.openPopupPreviewModal = function() {
    window.syncPreview();
    $('popupPreviewModal').showModal();
};
window.closePopupPreviewModal = function() {
    $('popupPreviewModal').close();
};

window.disableAllEventsQuick = async function() {
    if (!confirm("Bạn có muốn TẮT tạm thời toàn bộ Banner, Khu vực sự kiện và Popup trên trang chủ không? (Nội dung thiết kế vẫn được giữ nguyên để bật lại bất cứ lúc nào)")) return;
    $('evBannerActive').checked = false;
    $('evSectionActive').checked = false;
    $('evPopupActive').checked = false;
    window.syncPreview();
    await window.publishEventToCloud();
};
