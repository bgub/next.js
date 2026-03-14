import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

describe('content-collections', () => {
  const { next, isNextDev } = nextTestSetup({
    files: __dirname,
  })

  describe('list page', () => {
    it('should render all posts with links and dates', async () => {
      const $ = await next.render$('/')
      expect($('#count').text()).toBe('Post count: 2')

      const items = $('#posts li')
        .map((_, el) => {
          const $el = $(el)
          return {
            title: $el.find('a').text(),
            href: $el.find('a').attr('href'),
            date: $el.find('.date').text(),
          }
        })
        .get()

      expect(items).toEqual(
        expect.arrayContaining([
          {
            title: 'Hello World',
            href: '/posts/hello-world',
            date: expect.stringContaining('2024-01-01'),
          },
          {
            title: 'Second Post',
            href: '/posts/second-post',
            date: expect.stringContaining('2024-02-01'),
          },
        ])
      )
    })
  })

  describe('post page', () => {
    it('should render a single post by slug', async () => {
      const $ = await next.render$('/posts/hello-world')
      expect($('#title').text()).toBe('Hello World')
      expect($('#date').text()).toBe('2024-01-01')
    })

    it('should 404 for a non-existent post', async () => {
      const res = await next.fetch('/posts/does-not-exist')
      expect(res.status).toBe(404)
    })
  })

  describe('client navigation', () => {
    it('should navigate from list to post and back', async () => {
      const browser = await next.browser('/')
      expect(await browser.elementByCss('#count').text()).toBe('Post count: 2')

      await browser.elementByCss('a[href="/posts/hello-world"]').click()
      await browser.waitForElementByCss('#title')
      expect(await browser.elementByCss('#title').text()).toBe('Hello World')

      await browser.back()
      await browser.waitForElementByCss('#count')
      expect(await browser.elementByCss('#count').text()).toBe('Post count: 2')
    })
  })

  describe('computed fields', () => {
    it('should include computed readingTime on posts', async () => {
      const $ = await next.render$('/computed')
      const items = $('#reading-times li')
        .map((_, el) => {
          const $el = $(el)
          return {
            title: $el.find('.title').text(),
            time: $el.find('.time').text(),
          }
        })
        .get()

      // Each post should have a reading time of at least 1 minute
      for (const item of items) {
        expect(item.time).toMatch(/\d+ min read/)
      }
    })
  })

  describe('inline loader (products)', () => {
    it('should render products from inline loader', async () => {
      const $ = await next.render$('/products')
      expect($('#product-count').text()).toBe('Product count: 2')

      const items = $('#products li')
        .map((_, el) => {
          const $el = $(el)
          return {
            name: $el.find('.name').text(),
            price: $el.find('.price').text(),
          }
        })
        .get()

      expect(items).toEqual(
        expect.arrayContaining([
          { name: 'Widget', price: expect.stringContaining('9.99') },
          { name: 'Gadget', price: expect.stringContaining('19.99') },
        ])
      )
    })
  })

  if (isNextDev) {
    it('should update when a content file is modified', async () => {
      let $ = await next.render$('/')
      const titles = $('#posts li a')
        .map((_, el) => $(el).text())
        .get()
      expect(titles).toContain('Hello World')

      await next.patchFile(
        'content/posts/hello-world.md',
        (content) =>
          content.replace('title: Hello World', 'title: Hello Universe'),
        async () => {
          await retry(async () => {
            $ = await next.render$('/')
            const updated = $('#posts li a')
              .map((_, el) => $(el).text())
              .get()
            expect(updated).toContain('Hello Universe')
          })

          // Detail page should also reflect the change
          await retry(async () => {
            $ = await next.render$('/posts/hello-world')
            expect($('#title').text()).toBe('Hello Universe')
          })
        }
      )

      await retry(async () => {
        $ = await next.render$('/')
        const reverted = $('#posts li a')
          .map((_, el) => $(el).text())
          .get()
        expect(reverted).toContain('Hello World')
      })
    })

    it('should update when a new content file is added', async () => {
      let $ = await next.render$('/')
      expect($('#count').text()).toBe('Post count: 2')

      await next.patchFile(
        'content/posts/third-post.md',
        "---\ntitle: Third Post\ndate: '2024-03-01'\ndraft: false\n---\nThird post content.\n",
        async () => {
          await retry(async () => {
            $ = await next.render$('/')
            expect($('#count').text()).toBe('Post count: 3')
            const items = $('#posts li a')
              .map((_, el) => $(el).text())
              .get()
            expect(items).toContain('Third Post')
          })
        }
      )

      await retry(async () => {
        $ = await next.render$('/')
        expect($('#count').text()).toBe('Post count: 2')
      })
    })
  }
})
