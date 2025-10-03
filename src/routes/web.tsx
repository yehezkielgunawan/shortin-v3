import { Hono } from 'hono'
import { Script } from 'vite-ssr-components/hono'

const web = new Hono()

web.get('/', (c) => {
  return c.render(
    <main class="mx-auto max-w-xl p-6 space-y-6">
      <header class="space-y-1">
        <h1 class="text-2xl font-semibold">Shortin v3</h1>
        <p class="text-sm text-gray-600">Paste a long URL and optionally provide a custom code.</p>
      </header>

      <section id="app-root"></section>

      <Script>
        {`
import { render } from 'hono/jsx/dom'
import App from '/src/routes/web_client'
const root = document.getElementById('app-root')
render(App(), root)
        `}
      </Script>
    </main>
  )
})

export default web
