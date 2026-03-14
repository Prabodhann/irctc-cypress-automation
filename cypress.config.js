const { defineConfig } = require("cypress");
const { setupPuppeteer } = require('@cypress/puppeteer');

module.exports = defineConfig({
  projectId: '7afdkj',

  defaultCommandTimeout: 120000,
  pageLoadTimeout: 120000,
  requestTimeout: 30000,
  responseTimeout: 120000,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  // video: true,

  e2e: {
    setupNodeEvents(on, config) {
      // implement node event listeners here
      on('task', {
        log(message) {
          // Then to see the log messages in the terminal
          //   cy.task("log", "my message");
          console.log(message + '\n\n');
          return null;
        },
      });

      on('before:browser:launch', (browser = {}, launchOptions) => {
        if (browser.family === 'chromium' && browser.name !== 'electron') {
          // auto open devtools
          launchOptions.args.push('--disable-dev-shm-usage')
          launchOptions.args.push('--disable-blink-features=AutomationControlled')
        }
        return launchOptions
      })

      setupPuppeteer(on, config, {
        onMessage: {
          async goto (browser, url) {
            const page = await browser.newPage()
            await page.goto(url)
            return null
          },
        },
      });
      return config;
    },
    chromeWebSecurity: false,
    experimentalModifyObstructiveThirdPartyCode: false
  },
});


