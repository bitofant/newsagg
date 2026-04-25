import { createDb } from './db/index.js'
import { createAi } from './ai/index.js'
import { createGrabber } from './grabber/index.js'
import { createConsolidator } from './consolidator/index.js'
import { createAggregator } from './aggregator/index.js'
import { createProfiler } from './profiler/index.js'
import { createServer } from './server/index.js'
import { config } from './config.js'

async function main() {
  const db = createDb(config.dbPath)
  const ai = await createAi(config.ai)

  const consolidator = createConsolidator({ db, ai, config: config.consolidator })
  const grabber = createGrabber({ feeds: config.feeds, onArticle: consolidator.enqueue })

  // Late-bound so the callback can reference server without a circular dependency
  let notifyFrontPage: ((userId: number, generatedAt: number) => void) | undefined

  const aggregator = createAggregator({
    db,
    ai,
    config: config.aggregator,
    onFrontPageGenerated: (userId, generatedAt) => {
      notifyFrontPage?.(userId, generatedAt)
    },
  })

  const profiler = createProfiler({ db, ai })

  const server = await createServer({ db, ai, aggregator, consolidator, profiler, config: config.server })
  notifyFrontPage = server.notifyFrontPageGenerated.bind(server)

  await server.listen()
  grabber.start()
  consolidator.start()
  aggregator.start()

  console.log(`newsagg running on port ${config.server.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
