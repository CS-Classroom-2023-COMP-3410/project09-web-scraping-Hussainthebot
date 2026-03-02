const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');

// helper to make requests
async function fetchPage(url, params = {}) {
  const res = await axios.get(url, {
    params,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
    timeout: 15000,
  });
  return res.data;
}

// Task 1 - scrape upper division CS courses with no prereqs from DU bulletin
async function scrapeBulletin() {
  const html = await fetchPage('https://bulletin.du.edu/undergraduate/coursedescriptions/comp/');
  const $ = cheerio.load(html);
  const courses = [];

  $('p').each((_, el) => {
    const $el = $(el);
    const strongText = $el.find('strong').first().text().trim();

    const headerMatch = strongText.match(/^(COMP\s+(\d{4})\s+.+?)\s+\(\d+/);
    if (!headerMatch) return;

    const courseNum = parseInt(headerMatch[2], 10);
    if (courseNum < 3000) return;

    // skip anything that mentions a prereq
    if ($el.text().toLowerCase().includes('prerequisite')) return;

    const titleMatch = strongText.match(/^(COMP\s+\d{4})\s+(.+?)\s+\(\d+/);
    if (!titleMatch) return;

    const courseCode = titleMatch[1].replace(/\s+/, '-');
    const courseTitle = titleMatch[2].trim();

    courses.push({ course: courseCode, title: courseTitle });
  });

  await fs.writeJson('results/bulletin.json', { courses }, { spaces: 2 });
  console.log(`bulletin.json saved with ${courses.length} courses`);
}

// list of sport schedule pages to pull upcoming games from
const sports = [
  { name: "Men's Basketball",   url: 'https://denverpioneers.com/sports/mens-basketball/schedule' },
  { name: "Women's Basketball", url: 'https://denverpioneers.com/sports/womens-basketball/schedule' },
  { name: "Men's Ice Hockey",   url: 'https://denverpioneers.com/sports/mens-ice-hockey/schedule/2025-26' },
  { name: "Women's Gymnastics", url: 'https://denverpioneers.com/sports/womens-gymnastics/schedule' },
  { name: "Men's Swimming",     url: 'https://denverpioneers.com/sports/mens-swimming-and-diving/schedule' },
  { name: "Women's Swimming",   url: 'https://denverpioneers.com/sports/womens-swimming-and-diving/schedule' },
  { name: "Men's Tennis",       url: 'https://denverpioneers.com/sports/mens-tennis/schedule' },
  { name: "Women's Tennis",     url: 'https://denverpioneers.com/sports/womens-tennis/schedule' },
  { name: "Men's Lacrosse",     url: 'https://denverpioneers.com/sports/mens-lacrosse/schedule' },
  { name: "Women's Lacrosse",   url: 'https://denverpioneers.com/sports/womens-lacrosse/schedule' },
];

function getUpcomingGames(html, sportName) {
  const $ = cheerio.load(html);
  const games = [];

  $('li').each((_, el) => {
    const $li = $(el);
    const text = $li.text();

    if (!text.includes('vs') && !text.includes(' at ')) return;

    // games that already happened will have a score like "W, 3-1"
    if (/\b[WLT],\s*\d/.test(text)) return;

    let opponent = '';
    $li.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const label = $(a).text().trim();
      if (
        (href.startsWith('http') && !href.includes('denverpioneers')) ||
        href.includes('/opponent-history/')
      ) {
        opponent = label;
        return false;
      }
    });

    if (!opponent) return;

    const dateMatch = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\(\w+\)/);
    const date = dateMatch ? dateMatch[0] : 'TBD';

    games.push({ duTeam: sportName, opponent: opponent.trim(), date });
  });

  return games;
}

// Task 2 - the homepage carousel loads via JS so we scrape each sport schedule page directly
async function scrapeAthletics() {
  const allGames = [];

  for (const sport of sports) {
    try {
      const html = await fetchPage(sport.url);
      const games = getUpcomingGames(html, sport.name);
      allGames.push(...games);
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.log(`couldn't load ${sport.name}: ${err.message}`);
    }
  }

  const events = allGames.slice(0, 20);
  await fs.writeJson('results/athletic_events.json', { events }, { spaces: 2 });
  console.log(`athletic_events.json saved with ${events.length} events`);
}

async function getEventsForMonth(year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  const html = await fetchPage('https://www.du.edu/calendar', {
    start_date: startDate,
    end_date: endDate,
  });

  const $ = cheerio.load(html);
  const events = [];

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';

    if (!href.includes('/events/') && !href.includes('/registrar/events/') && !href.includes('/node/')) return;
    if (href.startsWith('#')) return;

    const rawText = $a.text().trim();
    if (!rawText) return;

    const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return;

    const dateLine = lines[0];
    if (!/^[A-Za-z]+ \d+$/.test(dateLine)) return;

    const date = `${dateLine}, ${year}`;

    let titleIdx = 1;
    while (titleIdx < lines.length && lines[titleIdx].toLowerCase() === 'view details') {
      titleIdx++;
    }

    const title = lines[titleIdx] || '';
    if (!title || title.toLowerCase() === 'view details') return;

    let time = null;
    for (let i = titleIdx + 1; i < lines.length; i++) {
      if (/\d+:\d+\s*[ap]m/i.test(lines[i])) {
        time = lines[i];
        break;
      }
    }

    const eventUrl = href.startsWith('http') ? href : `https://www.du.edu${href}`;
    events.push({ title, date, time, url: eventUrl });
  });

  return events;
}

async function getDescription(url) {
  try {
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    let desc = $('.field--name-body, .event-description, .field-name-body, [class*="event-body"]')
      .first()
      .text()
      .trim();

    if (!desc) {
      $('main p, #main-content p, .main-content p').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 50) {
          desc = text;
          return false;
        }
      });
    }

    return desc || null;
  } catch {
    return null;
  }
}

// Task 3 - scrape all DU calendar events for 2025
async function scrapeCalendar() {
  const allEvents = [];
  const seen = new Set();

  for (let month = 1; month <= 12; month++) {
    try {
      const monthEvents = await getEventsForMonth(2025, month);
      for (const ev of monthEvents) {
        const key = `${ev.title}|${ev.date}`;
        if (!seen.has(key)) {
          seen.add(key);
          allEvents.push(ev);
        }
      }
      console.log(`2025-${String(month).padStart(2, '0')}: ${monthEvents.length} events`);
    } catch (err) {
      console.log(`error on month ${month}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`total: ${allEvents.length} events, now fetching descriptions...`);

  const CONCURRENCY = 5;
  const events = [];

  for (let i = 0; i < allEvents.length; i += CONCURRENCY) {
    const batch = allEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ev) => {
        const description = await getDescription(ev.url);
        const entry = { title: ev.title, date: ev.date };
        if (ev.time) entry.time = ev.time;
        if (description) entry.description = description;
        return entry;
      })
    );
    events.push(...results);
    await new Promise(r => setTimeout(r, 200));
  }

  await fs.writeJson('results/calendar_events.json', { events }, { spaces: 2 });
  console.log(`calendar_events.json saved with ${events.length} events`);
}

async function main() {
  await fs.ensureDir('results');

  try {
    await scrapeBulletin();
  } catch (err) {
    console.error('bulletin scraper failed:', err.message);
  }

  try {
    await scrapeAthletics();
  } catch (err) {
    console.error('athletics scraper failed:', err.message);
  }

  try {
    await scrapeCalendar();
  } catch (err) {
    console.error('calendar scraper failed:', err.message);
  }
}

main();