import { test, expect, Page, Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Load .env file manually (avoids dependency on dotenv package)
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf-8').split('\n');
  envConfig.forEach(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.substring(0, eqIdx).trim();
      const value = line.substring(eqIdx + 1).trim();
      if (key) process.env[key] = value;
    }
  });
}

import passengerData from '../cypress/fixtures/passenger_data.json';
import { formatDate, hasTatkalAlreadyOpened, tatkalOpenTimeForToday } from '../cypress/utils/index';

const {
  PASSENGER_DETAILS,
  SOURCE_STATION,
  DESTINATION_STATION,
  TRAIN_NO,
  TRAIN_COACH,
  TRAVEL_DATE,
  TATKAL,
  PREMIUM_TATKAL,
  BOARDING_STATION,
  UPI_ID_CONFIG
} = passengerData as any;

const username = process.env.USERNAME || '';
const password = process.env.PASSWORD || '';
const MANUAL_CAPTCHA = process.env.MANUAL_CAPTCHA === 'true';

// ------------------------------------------------------------------
// Login helper — IRCTC no longer requires captcha at login.
// Clicks SIGN IN button and waits for the page to show logged-in state.
// ------------------------------------------------------------------
async function performLogin(page: Page): Promise<void> {
  console.log('Submitting login form...');
  await page.waitForTimeout(1500); // wait for Angular to bind events

  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await page.waitForTimeout(3000);

  const bodyText = await page.locator('body').innerText();
  if (
    bodyText.includes('Logout') ||
    bodyText.includes('Sign Out') ||
    bodyText.includes('Welcome') ||
    bodyText.toLowerCase().includes(username.toLowerCase())
  ) {
    console.log('Login successful!');
    return;
  }
  // Retry if not yet logged in
  console.log('Login not confirmed yet, retrying...');
  await page.waitForTimeout(1000);
  return performLogin(page);
}

async function solveCaptcha(page: Page): Promise<void> {
  console.log('Waiting for review booking page (reviewBooking URL)...');
  
  // Step 1: Wait for URL to be the reviewBooking page
  try {
    await page.waitForURL('**/booking/reviewBooking**', { timeout: 45000 });
    console.log('On reviewBooking page!');
  } catch {
    const currentUrl = page.url();
    console.log(`URL did not change to reviewBooking. Current: ${currentUrl}`);
    const bodyText = await page.locator('body').innerText();
    if (bodyText.includes('Payment Methods')) {
      console.log('Already on Payment Methods page.');
      return;
    }
  }
  
  // Step 2: Wait for captcha image to appear — try multiple strategies
  console.log('Waiting for captcha image to appear...');
  
  // Use JS to find ALL images and their sources (catches any captcha regardless of class)
  const allImgSrcs = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.map(img => ({ src: img.src.substring(0, 60), className: img.className, id: img.id, alt: img.alt }));
  });
  console.log('All images on page:', JSON.stringify(allImgSrcs));
  
  const captchaImg = page.locator('.captcha-img, app-captcha img, img[src*="captcha"], img[alt*="captcha" i]').first();
  try {
    await captchaImg.waitFor({ state: 'visible', timeout: 20000 });
    console.log('Captcha image is now visible on the page.');
  } catch {
    console.log('Captcha image not visible yet, checking body...');
    const bodyText = await page.locator('body').innerText();
    if (bodyText.includes('Payment Methods')) {
      console.log('Payment Methods visible — no captcha needed.');
      return;
    }
  }

  if (MANUAL_CAPTCHA) {
    console.log('\n======================================');
    console.log('MANUAL CAPTCHA: Please TYPE the captcha in the browser window now!');
    console.log('======================================\n');
    
    // Focus captcha input so user can immediately start typing
    const captchaInput = page.locator('#captcha, input[name="captcha"]').first();
    try {
      await captchaInput.waitFor({ state: 'visible', timeout: 10000 });
      await captchaInput.focus();
      console.log('Captcha input focused. Waiting for Payment Methods (up to 3 minutes)...');
    } catch {
      console.log('Could not auto-focus captcha input. Please click it manually.');
    }
    
    // Wait up to 3 minutes for user to solve the captcha
    await expect(page.locator('body')).toContainText('Payment Methods', { timeout: 180000 });
    console.log('Payment Methods appeared — captcha solved successfully!');
    return;
  }

  // Automated OCR mode
  let attempts = 30;
  while (attempts > 0) {
    attempts--;
    const bodyText = await page.locator('body').innerText();
    if (bodyText.includes('Payment Methods')) {
      console.log('Captcha solved! Payment Methods visible.');
      return;
    }
    if (bodyText.includes('No seats available')) {
      throw new Error('No seats available.');
    }

    // Find captcha image (try multiple selectors)
    const captchaSelectors = ['.captcha-img', 'app-captcha img', 'img[src*="captcha"]', 'img[alt*="captcha" i]'];
    let src: string | null = null;
    for (const sel of captchaSelectors) {
      const el = page.locator(sel);
      if (await el.count() > 0) {
        src = await el.first().getAttribute('src');
        if (src) { console.log(`Captcha img found: ${sel}`); break; }
      }
    }
    if (!src) {
      const allBase64Imgs = page.locator('img[src^="data:"]');
      if (await allBase64Imgs.count() > 0) {
        src = await allBase64Imgs.first().getAttribute('src');
      }
    }
    if (!src) {
      console.log(`No captcha image found, waiting 2s... (${attempts} left)`);
      await page.waitForTimeout(2000);
      continue;
    }

    const response = await page.request.post('http://localhost:5001/extract-text', { data: { image: src } });
    const { extracted_text } = await response.json();
    console.log(`Trying captcha: '${extracted_text}'`);

    const captchaInput = page.locator('#captcha, input[name="captcha"]').first();
    await captchaInput.fill(extracted_text);
    await captchaInput.press('Enter');
    await page.waitForTimeout(2000);

    const newBody = await page.locator('body').innerText();
    if (newBody.includes('Payment Methods')) { console.log('Captcha solved!'); return; }
    if (newBody.includes('Invalid Captcha') || newBody.includes('Please Try again')) {
      console.log('Wrong captcha, retrying...');
    }
  }
  throw new Error('Exceeded captcha attempts.');
}

// ------------------------------------------------------------------

// Train selector — clicks coach class, date cell, then Book Now.
// Recurse only if not yet on Passenger Details page.
// ------------------------------------------------------------------
async function selectTrainAndBookNow(page: Page): Promise<void> {
  await page.waitForTimeout(1900);

  if (TATKAL && !hasTatkalAlreadyOpened(TRAIN_COACH)) {
    const exactTimeToOpen = tatkalOpenTimeForToday(TRAIN_COACH);
    console.log(`Waiting until Tatkal opens at ${exactTimeToOpen}...`);
    await expect(page.locator('div.h_head1')).toContainText(exactTimeToOpen, { timeout: 300000 });
  }

  const bodyText = await page.locator('body').innerText();

  if (
    bodyText.includes('Passenger Details') &&
    bodyText.includes('Contact Details') &&
    !bodyText.includes('Please Wait...')
  ) {
    console.log('Reached Passenger Details page!');
    return;
  }

  if (!bodyText.includes('Passenger Details') && !bodyText.includes('Please Wait...')) {

    if (bodyText.includes('Booking not yet started for the selected quota and class')) {
      console.log('Booking not yet started, retrying search...');
      await page.locator('button.train_Search').click();
      await page.waitForTimeout(2000);
    }

    // Wait for train results
    const trainBlocks = page.locator('.bull-back');
    await trainBlocks.first().waitFor({ state: 'visible', timeout: 60000 });
    const count = await trainBlocks.count();

    for (let i = 0; i < count; i++) {
      const div = trainBlocks.nth(i);
      const text = await div.innerText();

      if (text.includes(TRAIN_NO)) {
        console.log(`Found train ${TRAIN_NO}. Clicking coach ${TRAIN_COACH}...`);

        // Step 1: Click the coach class to expand the availability table
        await div.locator(`text=${TRAIN_COACH}`).first().click();
        await page.waitForTimeout(1500);

        // Step 2: Click the specific date cell in the expanded availability table
        const formattedDate = formatDate(TRAVEL_DATE);
        console.log(`Looking for date cell: ${formattedDate}`);
        const dateCells = div.locator('app-train-avl-enq td, app-train-avl-enq .avl-tab');
        const dateCellCount = await dateCells.count();
        let dateCellClicked = false;
        for (let d = 0; d < dateCellCount; d++) {
          const cellText = await dateCells.nth(d).innerText();
          if (cellText.includes(formattedDate)) {
            await dateCells.nth(d).click();
            console.log(`Clicked date cell: ${formattedDate}`);
            dateCellClicked = true;
            break;
          }
        }

        if (!dateCellClicked) {
          // Try the original Cypress selector structure
          try {
            const dateInPanel = div.locator('app-train-avl-enq').filter({ hasText: formattedDate })
              .locator('td, .avl-tab').filter({ hasText: formattedDate });
            await dateInPanel.first().click();
            dateCellClicked = true;
            console.log('Clicked date cell using panel filter');
          } catch {
            console.log('Date cell not found via panel, proceeding without clicking date...');
          }
        }

        await page.waitForTimeout(1000);

        // Step 3: Find Book Now in the ₹ price block
        const priceBlocks = div.locator('[style*="padding-top: 10px"]');
        const priceCount = await priceBlocks.count();
        let bookNowClicked = false;
        for (let p = 0; p < priceCount; p++) {
          const blockText = await priceBlocks.nth(p).innerText();
          if (blockText.includes('₹')) {
            const bookNowBtn = priceBlocks.nth(p).locator('text=Book Now');
            if (await bookNowBtn.count() > 0) {
              await bookNowBtn.first().click();
              console.log('Clicked Book Now (in price block)');
              bookNowClicked = true;
              break;
            }
          }
        }
        if (!bookNowClicked) {
          // Fallback — any visible Book Now button
          const pgBookNow = page.locator('text=Book Now');
          if (await pgBookNow.count() > 0) {
            await pgBookNow.first().click();
            console.log('Clicked Book Now (page fallback)');
          }
        }

        // Wait for successful navigation to Passenger Details
        try {
          await page.waitForSelector('text=Passenger Details', { timeout: 20000 });
          console.log('Successfully navigated to Passenger Details!');
          return;
        } catch {
          console.log('Passenger Details not shown, retrying booking...');
          return selectTrainAndBookNow(page);
        }
      }
    }
  } else {
    await page.waitForTimeout(1000);
    return selectTrainAndBookNow(page);
  }
}

// ------------------------------------------------------------------
// MAIN TEST
// ------------------------------------------------------------------
test('IRCTC TATKAL BOOKING COMPLETE', async ({ page }) => {
  test.setTimeout(300000); // 5 minutes total

  page.on('pageerror', err => console.log('Page error:', err.message));

  if (TATKAL && PREMIUM_TATKAL) {
    throw new Error('Make Sure Either TATKAL or PREMIUM TATKAL is True. Not BOTH');
  }

  await page.setViewportSize({ width: 1478, height: 1056 });
  await page.goto('https://www.irctc.co.in/nget/train-search', { timeout: 90000 });
  console.log('IRCTC website loaded.');

  const UPI_ID = process.env.UPI_ID || UPI_ID_CONFIG;
  const upiRegex = /^[a-zA-Z0-9]+@[a-zA-Z0-9.]+$/;
  const isValidUpiId = upiRegex.test(UPI_ID);

  // Dismiss any advisory/announcement modal
  const advisoryOkButton = page.locator('button.btn-primary, .btn.btn-primary').filter({ hasText: 'OK' });
  try {
    await advisoryOkButton.first().waitFor({ state: 'visible', timeout: 5000 });
    await advisoryOkButton.first().click();
    console.log('Dismissed advisory modal.');
  } catch {
    console.log('No advisory modal.');
  }

  // Click Login button
  console.log('Clicking LOGIN button...');
  const loginBtn = page.locator('a.search_btn.loginText, a:has-text("LOGIN"), a:has-text("Sign In")');
  await loginBtn.first().click();

  await page.waitForTimeout(1000);
  await page.locator('input[placeholder="User Name"]').fill(username);
  await page.locator('input[placeholder="Password"]').fill(password);

  await performLogin(page);

  // Dismiss "Your Last Transaction" dialog if present
  const bodyText0 = await page.locator('body').innerText();
  if (bodyText0.includes('Your Last Transaction')) {
    await page.locator('.ui-dialog-footer button, button:has-text("OK"), text=OK').first().click();
  }

  // From Station
  console.log(`Entering Source Station: ${SOURCE_STATION}`);
  const fromInput = page.locator("p-autocomplete[formcontrolname='origin'] input");
  await fromInput.click();
  await fromInput.clear();
  await fromInput.pressSequentially(SOURCE_STATION, { delay: 150 });
  await page.locator('li.ui-autocomplete-list-item').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('li.ui-autocomplete-list-item').first().click();

  // To Station
  console.log(`Entering Destination Station: ${DESTINATION_STATION}`);
  const toInput = page.locator("p-autocomplete[formcontrolname='destination'] input");
  await toInput.click();
  await toInput.clear();
  await toInput.pressSequentially(DESTINATION_STATION, { delay: 150 });
  await page.locator('li.ui-autocomplete-list-item').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('li.ui-autocomplete-list-item').first().click();

  // Travel Date
  console.log(`Entering Travel Date: ${TRAVEL_DATE}`);
  const dateInput = page.locator("p-calendar[formcontrolname='journeyDate'] input");
  await dateInput.click();
  await dateInput.clear();
  await dateInput.pressSequentially(TRAVEL_DATE, { delay: 100 });
  await dateInput.press('Tab');

  // Seat Quota
  if (TATKAL) {
    await page.locator('#journeyQuota .ui-dropdown, [formcontrolname="journeyQuota"]').click();
    await page.locator('.ui-dropdown-item:has-text("TATKAL"), li.ui-dropdown-item').filter({ hasText: 'TATKAL' }).first().click();
  } else if (PREMIUM_TATKAL) {
    await page.locator('#journeyQuota .ui-dropdown, [formcontrolname="journeyQuota"]').click();
    await page.locator('.ui-dropdown-item:has-text("PREMIUM TATKAL"), li.ui-dropdown-item').filter({ hasText: 'PREMIUM TATKAL' }).first().click();
  }

  // Dismiss calendar overlay and Search
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  console.log('Clicking Search Trains...');
  await page.locator('button.train_Search').click();

  // Find and book the train
  await selectTrainAndBookNow(page);

  // ================================================================
  // PASSENGER DETAILS FORM
  // ================================================================
  console.log('Waiting for Passenger Details form to fully load...');

  // Wait for the FIRST name input to be visible (no hardcoded delay — starts as soon as ready)
  console.log('Waiting for first passenger name input to be ready...');
  await page.locator('.ui-autocomplete input, input[formcontrolname="passengerName"]').first().waitFor({ state: 'visible', timeout: 30000 });
  console.log('Filling passenger details...');

  // Click blank space to deselect
  try { await page.locator('.fill > :nth-child(2)').click(); } catch { /* ignore */ }

  // Add extra passengers (beyond the first one)
  for (let i = 1; i < PASSENGER_DETAILS.length; i++) {
    await page.locator('.pull-left > a > :nth-child(1), .add-passenger a').first().click();
  }

  // Boarding station
  if (BOARDING_STATION) {
    await page.locator('.ui-dropdown.ui-widget.ui-corner-all').click();
    await page.locator('li.ui-dropdown-item', { hasText: BOARDING_STATION }).click();
  }

  // Fill Name (Angular autocomplete — must use pressSequentially to trigger ngModel)
  const nameInputs = page.locator('.ui-autocomplete input, input[formcontrolname="passengerName"]');
  const nameCount = await nameInputs.count();
  for (let i = 0; i < nameCount && i < PASSENGER_DETAILS.length; i++) {
    const nameInput = nameInputs.nth(i);
    await nameInput.click();
    await nameInput.clear();
    await nameInput.pressSequentially(PASSENGER_DETAILS[i].NAME, { delay: 50 });
    await nameInput.press('Tab');
    await page.waitForTimeout(300);
  }

  // Fill Age — must use Angular-compatible input approach
  const ageInputs = page.locator('input[formcontrolname="passengerAge"]');
  for (let i = 0; i < await ageInputs.count() && i < PASSENGER_DETAILS.length; i++) {
    const ageInput = ageInputs.nth(i);
    await ageInput.click();
    await ageInput.clear();
    // Use fill followed by keyboard input to trigger Angular change detection
    await ageInput.fill(String(PASSENGER_DETAILS[i].AGE));
    await ageInput.press('Tab');
  }

  // Fill Gender (use { label } to match by visible text)
  const genderSelects = page.locator('select[formcontrolname="passengerGender"]');
  for (let i = 0; i < await genderSelects.count() && i < PASSENGER_DETAILS.length; i++) {
    await genderSelects.nth(i).selectOption({ label: PASSENGER_DETAILS[i].GENDER });
  }

  // Fill Seat (use { label } to match by visible text)
  const seatSelects = page.locator('select[formcontrolname="passengerBerthChoice"]');
  for (let i = 0; i < await seatSelects.count() && i < PASSENGER_DETAILS.length; i++) {
    await seatSelects.nth(i).selectOption({ label: PASSENGER_DETAILS[i].SEAT });
  }

  // Fill Food (if available) — use { label } to match by visible text
  const foodSelects = page.locator('select[formcontrolname="passengerFoodChoice"]');
  for (let i = 0; i < await foodSelects.count() && i < PASSENGER_DETAILS.length; i++) {
    await foodSelects.nth(i).selectOption({ label: PASSENGER_DETAILS[i].FOOD });
  }

  // Confirmation checkboxes
  const reviewBody = await page.locator('body').innerText();
  if (reviewBody.includes('Book only if confirm berths are allotted')) {
    await page.locator(':nth-child(2) > .css-label_c').click();
  }
  if (reviewBody.includes('Consider for Auto Upgradation.')) {
    await page.locator('text=Consider for Auto Upgradation.').click();
  }

  // Payment type radio (UPI = option 2)
  console.log('Selecting UPI payment option...');
  await page.waitForTimeout(1000);
  const upiRadio = page.locator('#\\32  > .ui-radiobutton > .ui-radiobutton-box');
  if (await upiRadio.count() > 0) {
    await upiRadio.click();
  }
  
  // Wait 2 seconds for form validation to complete before submitting
  await page.waitForTimeout(2000);
  
  // Debug: check Angular form validity via JS before submitting
  const formValidity = await page.evaluate(() => {
    const forms = document.querySelectorAll('form');
    return Array.from(forms).map(f => ({ class: f.className, valid: (f as any).checkValidity?.() }));
  });
  console.log('Form validity check:', JSON.stringify(formValidity));
  
  // Take screenshot to see form state before submitting
  await page.screenshot({ path: '/tmp/irctc_before_submit.png', fullPage: false });
  console.log('Screenshot saved to /tmp/irctc_before_submit.png');
  
  console.log('Clicking Continue to proceed to review page...');
  
  // Debug: log all buttons on page to find the right one
  const allButtons = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.map(b => ({ text: b.innerText.trim().substring(0, 30), class: b.className.substring(0, 50), type: b.type, disabled: b.disabled }));
  });
  console.log('All buttons on page:', JSON.stringify(allButtons));
  
  // Try clicking the Continue button by text first, then by class
  const continueBtn = page.getByRole('button', { name: /continue/i }).or(page.locator('button.train_Search')).first();
  await continueBtn.click();


  // Wait and check if we hit the error page
  await page.waitForTimeout(3000);  
  const pageAfterSubmit = await page.locator('body').innerText();
  const urlAfterSubmit = page.url();
  console.log(`URL after submit: ${urlAfterSubmit}`);
  if (urlAfterSubmit.includes('/nget/error') || pageAfterSubmit.includes('Sorry!!! Please Try again!!')) {
    console.log('IRCTC error page after form submit.');
    // Try going back and re-submitting
    await page.goBack();
    await page.waitForTimeout(2000);
    await page.locator('.train_Search').click();
    await page.waitForTimeout(3000);
  }

  // Vande Bharat food popup
  await page.waitForTimeout(2000);
  const popupBody = await page.locator('body').innerText();
  if (popupBody.includes('Confirmation') && popupBody.includes('Enhance Your Travel with Taste')) {
    await page.locator('[icon="fa fa-close"] > .ui-button-text').click();
  }

  // Solve the booking-stage captcha
  console.log('Solving booking captcha...');
  await solveCaptcha(page);

  // Click Pay via payment gateway
  await page.locator(':nth-child(3) > .col-pad').click();
  await page.locator('.col-sm-9 > app-bank > #bank-type').click();
  await page.locator('.col-sm-9 > app-bank > #bank-type > :nth-child(2) > table > tr > :nth-child(1) > .col-lg-12 > .border-all > .col-xs-12 > .col-pad').click();
  await page.locator('button.btn, button:has-text("Pay")').first().click();

  console.log('Waiting for payment page to load (Paytm/UPI)...');
  await page.setViewportSize({ width: 460, height: 760 });

  await page.waitForResponse(
    response => response.url().includes('/theia/processTransaction?orderid=') && response.status() === 200,
    { timeout: 200000 }
  );

  if (UPI_ID && isValidUpiId) {
    await page.locator('#ptm-upi').click();
    await page.locator('.form-ctrl').fill(UPI_ID);
    await page.getByRole('button', { name: 'Pay' }).click();
    console.log('Payment initiated. Please confirm on your phone within 2 minutes.');
    await page.waitForTimeout(120000);
  }
});
