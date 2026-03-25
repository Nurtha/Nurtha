// Database
let items = [
  { id: 1, type: 'lost', title: 'Fluffy White Cat', cat: 'pets', loc: 'Oak Ridge Area', date: '2024-05-10', desc: 'Responds to "Snow", has a blue collar.', contact: '@user123' },
  { id: 2, type: 'found', title: 'Car Keys (Toyota)', cat: 'keys', loc: 'Starbucks Parking', date: '2024-05-12', desc: 'Found near the trash bin, black fob.', contact: '555-0199' },
  { id: 3, type: 'lost', title: 'Blue Backpack', cat: 'other', loc: 'University Library', date: '2024-05-11', desc: 'Contains textbooks and a grey hoodie.', contact: 'Library Front Desk' }
];

let currentFormType = 'lost';

// View Logic
function showView(view) {
  document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');

  // Style buttons
  const isHome = view === 'home';
  document.getElementById('btn-home').className = isHome ? 'px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-50 text-indigo-600' : 'px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100';
  document.getElementById('btn-report').className = !isHome ? 'px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-50 text-indigo-600' : 'px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100';

  if (isHome) renderItems();
}

function setFormType(type) {
  currentFormType = type;
  const lostBtn = document.getElementById('form-type-lost');
  const foundBtn = document.getElementById('form-type-found');

  if (type === 'lost') {
    lostBtn.className = "py-3 rounded-xl border-2 font-bold transition-all border-red-500 bg-red-50 text-red-600";
    foundBtn.className = "py-3 rounded-xl border-2 font-bold transition-all border-slate-100 bg-white text-slate-400";
  } else {
    foundBtn.className = "py-3 rounded-xl border-2 font-bold transition-all border-emerald-500 bg-emerald-50 text-emerald-600";
    lostBtn.className = "py-3 rounded-xl border-2 font-bold transition-all border-slate-100 bg-white text-slate-400";
  }
}

// Render Cards
function renderItems() {
  const grid = document.getElementById('items-grid');
  const search = document.getElementById('search-bar').value.toLowerCase();
  const typeFilter = document.getElementById('filter-type').value;
  const catFilter = document.getElementById('filter-cat').value;

  const filtered = items.filter(i => {
    const matchesSearch = i.title.toLowerCase().includes(search) || i.loc.toLowerCase().includes(search);
    const matchesType = typeFilter === 'all' || i.type === typeFilter;
    const matchesCat = catFilter === 'all' || i.cat === catFilter;
    return matchesSearch && matchesType && matchesCat;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '';
    document.getElementById('no-results').classList.remove('hidden');
    return;
  }

  document.getElementById('no-results').classList.add('hidden');
  grid.innerHTML = filtered.map(item => `
                <div class="item-card bg-white p-5 rounded-3xl border border-slate-200 shadow-sm hover:shadow-xl hover:shadow-indigo-100/50">
                    <div class="flex justify-between items-start mb-4">
                        <span class="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${item.type === 'lost' ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600'}">
                            ${item.type}
                        </span>
                        <div class="text-slate-400 text-xs">
                            <i class="far fa-calendar mr-1"></i> ${item.date}
                        </div>
                    </div>
                    <h3 class="text-lg font-bold text-slate-800 mb-2">${item.title}</h3>
                    <p class="text-slate-500 text-sm mb-4 line-clamp-2">${item.desc}</p>

                    <div class="space-y-2 mb-4 pt-3 border-t border-slate-50">
                        <div class="flex items-center text-xs text-slate-500">
                            <i class="fas fa-map-marker-alt w-5 text-indigo-400"></i> ${item.loc}
                        </div>
                        <div class="flex items-center text-xs text-slate-500">
                            <i class="fas fa-user-circle w-5 text-indigo-400"></i> Contact: ${item.contact}
                        </div>
                    </div>
                    <button onclick="showAlert('Contacting reporter...')" class="w-full py-2 text-xs font-bold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors">
                        View Details
                    </button>
                </div>
            `).join('');
}

// Form Logic
function handleFormSubmit(e) {
  e.preventDefault();
  const newItem = {
    id: Date.now(),
    type: currentFormType,
    title: document.getElementById('in-title').value,
    cat: document.getElementById('in-cat').value,
    loc: document.getElementById('in-loc').value,
    date: document.getElementById('in-date').value,
    desc: document.getElementById('in-desc').value,
    contact: document.getElementById('in-contact').value
  };

  items.unshift(newItem);
  document.getElementById('report-form').reset();
  setFormType('lost');
  showAlert('Your report has been posted!');
  showView('home');
}

// Utils
function showAlert(msg) {
  const box = document.getElementById('alert-box');
  document.getElementById('alert-msg').innerText = msg;
  box.style.opacity = '1';
  box.style.transform = 'translate(-50%, 0)';
  setTimeout(() => {
    box.style.opacity = '0';
    box.style.transform = 'translate(-50%, 40px)';
  }, 3000);
}

// Start
window.onload = () => {
  document.getElementById('in-date').valueAsDate = new Date();
  renderItems();
};