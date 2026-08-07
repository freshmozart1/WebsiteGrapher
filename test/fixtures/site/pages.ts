/**
 * The fixture site. Everything the analyzer must recognise lives here, so the
 * browser-facing half of the test suite is deterministic and offline.
 *
 * Built as strings rather than loose .html files: the pages share a shell and
 * a product set, and keeping them together makes the structural variations
 * (three pagination modes, a POST form, destructive controls) easy to compare.
 */

export interface Product {
    id: number;
    title: string;
    price: string;
    category: 'fiction' | 'tech';
    rating: number;
    stock: number;
    blurb: string;
}

export const PRODUCTS: Product[] = [
    {
        id: 1,
        title: 'The Silent Harbour',
        price: '£12.99',
        category: 'fiction',
        rating: 4,
        stock: 7,
        blurb: 'A slow novel about a lighthouse keeper who stops writing letters.',
    },
    {
        id: 2,
        title: 'Compilers in Anger',
        price: '£48.50',
        category: 'tech',
        rating: 5,
        stock: 2,
        blurb: 'Field notes from a decade of shipping type checkers that nobody asked for.',
    },
    {
        id: 3,
        title: 'Salt and Signal',
        price: '£9.25',
        category: 'fiction',
        rating: 3,
        stock: 0,
        blurb: 'Short stories set along a coastline that keeps rearranging itself.',
    },
    {
        id: 4,
        title: 'Distributed Regret',
        price: '£61.00',
        category: 'tech',
        rating: 4,
        stock: 11,
        blurb: 'On consensus protocols, and the meetings they were meant to replace.',
    },
    {
        id: 5,
        title: "The Cartographer's Error",
        price: '£15.75',
        category: 'fiction',
        rating: 5,
        stock: 4,
        blurb: 'A mapmaker draws an island that is not there, and then it is.',
    },
    {
        id: 6,
        title: 'Garbage Collection',
        price: '£33.40',
        category: 'tech',
        rating: 2,
        stock: 1,
        blurb: 'Memory management explained through the medium of household chores.',
    },
];

const PAGE_SIZE = 3;

function shell(title: string, body: string, head = ''): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    header { padding: 1rem; border-bottom: 1px solid #ccc; }
    nav a { margin-right: 1rem; }
    main { padding: 1rem; }
    .products { list-style: none; padding: 0; display: grid; gap: 1rem; }
    .product-card { border: 1px solid #ddd; padding: 1rem; }
    .price { font-weight: bold; }
    .hidden { display: none; }
    footer { padding: 1rem; border-top: 1px solid #ccc; }
  </style>
  ${head}
</head>
<body>
  <header>
    <nav aria-label="Main">
      <a href="/index.html">Home</a>
      <a href="/products.html">Products</a>
      <a href="/search.html">Search</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </header>
  <main>${body}</main>
  <footer><a href="/about.html">About</a></footer>
</body>
</html>`;
}

function card(p: Product): string {
    return `
    <li class="product-card" data-category="${p.category}" data-price="${p.price.slice(1)}">
      <img class="thumb" src="/img/${p.id}.svg" alt="${p.title} cover">
      <h3><a href="/product/${p.id}.html">${p.title}</a></h3>
      <p class="price">${p.price}</p>
      <p class="stock">${p.stock > 0 ? `In stock (${p.stock})` : 'Out of stock'}</p>
    </li>`;
}

/** Controls that genuinely mutate the list, so a DOM diff can see the change. */
const LIST_SCRIPT = `
<script>
  function applyControls() {
    var category = document.getElementById('category').value;
    var query = document.getElementById('q').value.trim().toLowerCase();
    var sort = document.getElementById('sort').value;
    var list = document.querySelector('.products');
    var items = Array.prototype.slice.call(list.querySelectorAll('.product-card'));

    items.forEach(function (item) {
      var titleEl = item.querySelector('h3 a');
      var title = titleEl ? titleEl.textContent.toLowerCase() : '';
      var matches =
        (category === 'all' || item.dataset.category === category) &&
        (query === '' || title.indexOf(query) !== -1);
      item.classList.toggle('hidden', !matches);
    });

    if (sort !== 'default') {
      items.sort(function (a, b) {
        var pa = parseFloat(a.dataset.price), pb = parseFloat(b.dataset.price);
        return sort === 'price-asc' ? pa - pb : pb - pa;
      });
      items.forEach(function (item) { list.appendChild(item); });
    }
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('category').addEventListener('change', applyControls);
    document.getElementById('sort').addEventListener('change', applyControls);
    document.getElementById('q').addEventListener('input', applyControls);
    document.getElementById('newsletter').addEventListener('click', function (e) {
      e.preventDefault(); // deliberately changes nothing: a no-op probe
    });
  });
</script>`;

function controls(): string {
    return `
    <form class="controls" method="get" action="/products.html">
      <label for="category">Category</label>
      <select id="category" name="category">
        <option value="all">All categories</option>
        <option value="fiction">Fiction</option>
        <option value="tech">Technology</option>
      </select>

      <label for="sort">Sort by</label>
      <select id="sort" name="sort">
        <option value="default">Relevance</option>
        <option value="price-asc">Price: low to high</option>
        <option value="price-desc">Price: high to low</option>
      </select>

      <label for="q">Search products</label>
      <input id="q" name="q" type="search" placeholder="Search products">

      <button type="button" id="newsletter">Newsletter</button>
    </form>`;
}

function pager(page: number, total: number): string {
    const pages = Math.ceil(total / PAGE_SIZE);
    const links: string[] = [];
    for (let n = 1; n <= pages; n++) {
        links.push(
            n === page
                ? `<span class="current" aria-current="page">${n}</span>`
                : `<a href="/products.html?page=${n}">${n}</a>`,
        );
    }
    return `
    <nav class="pager" aria-label="Pagination">
      ${page > 1 ? `<a class="prev" href="/products.html?page=${page - 1}">Previous</a>` : ''}
      ${links.join(' ')}
      ${page < pages ? `<a class="next" href="/products.html?page=${page + 1}">Next</a>` : ''}
    </nav>`;
}

export function homePage(): string {
    return shell(
        'Fixture Bookshop',
        `
    <h1>Fixture Bookshop</h1>
    <p>A small shop that exists only to be analyzed.</p>
    <p><a class="cta" href="/products.html">Browse all products</a></p>`,
    );
}

export function productsPage(page = 1): string {
    const start = (page - 1) * PAGE_SIZE;
    const visible = PRODUCTS.slice(start, start + PAGE_SIZE);
    return shell(
        'Products — Fixture Bookshop',
        `
    <h1>Products</h1>
    ${controls()}
    <ol class="products">${visible.map(card).join('')}</ol>
    ${pager(page, PRODUCTS.length)}`,
        LIST_SCRIPT,
    );
}

/** Same list, revealed by a button instead of page links. */
export function loadMorePage(): string {
    return shell(
        'All products — Fixture Bookshop',
        `
    <h1>All products</h1>
    <ol class="products">${PRODUCTS.slice(0, 3).map(card).join('')}</ol>
    <button id="load-more" type="button">Load more</button>
    <template id="rest">${PRODUCTS.slice(3).map(card).join('')}</template>`,
        `<script>
      document.addEventListener('DOMContentLoaded', function () {
        document.getElementById('load-more').addEventListener('click', function () {
          var tpl = document.getElementById('rest');
          document.querySelector('.products').insertAdjacentHTML('beforeend', tpl.innerHTML);
          this.remove();
        });
      });
    </script>`,
    );
}

/** Same list again, revealed by scrolling. */
export function infiniteScrollPage(): string {
    return shell(
        'Feed — Fixture Bookshop',
        `
    <h1>Feed</h1>
    <ol class="products">${PRODUCTS.slice(0, 3).map(card).join('')}</ol>
    <div style="height: 1400px"></div>
    <template id="rest">${PRODUCTS.slice(3).map(card).join('')}</template>`,
        `<script>
      var loaded = false;
      window.addEventListener('scroll', function () {
        if (loaded) return;
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 50) {
          loaded = true;
          var tpl = document.getElementById('rest');
          document.querySelector('.products').insertAdjacentHTML('beforeend', tpl.innerHTML);
        }
      });
    </script>`,
    );
}

export function detailPage(product: Product): string {
    return shell(
        `${product.title} — Fixture Bookshop`,
        `
    <article class="product">
      <div id="gallery"><img src="/img/${product.id}.svg" alt="${product.title} cover"></div>
      <h1>${product.title}</h1>
      <p class="price">${product.price}</p>
      <p class="rating" data-rating="${product.rating}">${'★'.repeat(product.rating)}${'☆'.repeat(5 - product.rating)}</p>
      <p class="availability">${product.stock > 0 ? `In stock (${product.stock} available)` : 'Out of stock'}</p>
      <h2 id="description-heading">Description</h2>
      <p class="description">${product.blurb}</p>
      <table class="specs">
        <tr><th>Category</th><td>${product.category}</td></tr>
        <tr><th>Product ID</th><td>${product.id}</td></tr>
      </table>
      <button type="button" class="buy">Buy now</button>
      <a class="back" href="/products.html">Back to products</a>
    </article>`,
    );
}

export function searchPage(): string {
    return shell(
        'Search — Fixture Bookshop',
        `
    <h1>Search</h1>
    <form method="get" action="/products.html">
      <label for="sq">What are you looking for?</label>
      <input id="sq" name="q" type="search" placeholder="Title or author">
      <button type="submit">Search</button>
    </form>`,
    );
}

/** A POST form: every control inside it must be blocked from probing. */
export function contactPage(): string {
    return shell(
        'Contact — Fixture Bookshop',
        `
    <h1>Contact us</h1>
    <form method="post" action="/contact">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required>
      <label for="message">Message</label>
      <textarea id="message" name="message"></textarea>
      <label for="subscribe"><input id="subscribe" name="subscribe" type="checkbox"> Subscribe to the newsletter</label>
      <button type="submit">Send message</button>
    </form>`,
    );
}

/** Controls whose labels alone should keep the learner away from them. */
export function accountPage(): string {
    return shell(
        'Account — Fixture Bookshop',
        `
    <h1>Your account</h1>
    <button type="button" class="danger">Delete my account</button>
    <button type="button">Unsubscribe</button>
    <a href="/logout">Log out</a>
    <a href="/checkout">Proceed to checkout</a>
    <a href="https://example.org/partner">Partner site</a>`,
    );
}

export function aboutPage(): string {
    return shell(
        'About — Fixture Bookshop',
        `<h1>About</h1><p>Nothing to see.</p>`,
    );
}

/**
 * A page-builder-style grid: six role cards split 3+3 across two row
 * wrappers, each row and each card carrying its own per-instance hash class
 * (the way Elementor, Webflow and CSS Modules all generate markup) alongside
 * a shared structural class. Exercises both `structure.ts` fixes together —
 * without hash normalization, not even one row's three cards would bucket
 * together; the row-merge pass is what then reads the two rows as one
 * six-item cluster instead of two three-item fragments.
 */
function roleCard(hash: string, slug: string, title: string): string {
    return `
        <div class="role-card role-card-${hash}">
          <h3>${title}</h3>
          <a href="/careers/${slug}.html">View role</a>
        </div>`;
}

export function careersPage(): string {
    return shell(
        'Careers — Fixture Bookshop',
        `
    <h1>Careers</h1>
    <div class="grid-wrap">
      <div class="role-row role-row-a1b2c3">
        ${roleCard('d4e5f6', 'engineer', 'Software Engineer')}
        ${roleCard('a7b8c9', 'designer', 'Product Designer')}
        ${roleCard('1a2b3c', 'analyst', 'Data Analyst')}
      </div>
      <div class="role-row role-row-4d5e6f">
        ${roleCard('7a8b9c', 'manager', 'Engineering Manager')}
        ${roleCard('3c4d5e', 'writer', 'Technical Writer')}
        ${roleCard('9e0f1a', 'recruiter', 'Recruiter')}
      </div>
    </div>`,
        `<style>
      .grid-wrap { display: flex; flex-direction: column; gap: 1rem; }
      .role-row { display: flex; gap: 1rem; }
      .role-card { width: 200px; height: 150px; border: 1px solid #ccc; padding: 1rem; box-sizing: border-box; }
    </style>`,
    );
}

function coverSvg(product: Product): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160">
  <rect width="120" height="160" fill="#eef"/>
  <text x="60" y="80" text-anchor="middle" font-size="12">${product.id}</text>
</svg>`;
}

/** Every path the fixture server answers. */
export function routes(): Map<string, { body: string; type: string }> {
    const map = new Map<string, { body: string; type: string }>();
    const html = (body: string) => ({ body, type: 'text/html; charset=utf-8' });

    map.set('/', html(homePage()));
    map.set('/index.html', html(homePage()));
    map.set('/products.html', html(productsPage(1)));
    map.set('/load-more.html', html(loadMorePage()));
    map.set('/feed.html', html(infiniteScrollPage()));
    map.set('/search.html', html(searchPage()));
    map.set('/contact.html', html(contactPage()));
    map.set('/account.html', html(accountPage()));
    map.set('/about.html', html(aboutPage()));
    map.set('/careers.html', html(careersPage()));

    for (const product of PRODUCTS) {
        map.set(`/product/${product.id}.html`, html(detailPage(product)));
        map.set(`/img/${product.id}.svg`, {
            body: coverSvg(product),
            type: 'image/svg+xml',
        });
    }
    return map;
}

export const PAGE_SIZE_FOR_TESTS = PAGE_SIZE;
