const DHT = require('@hyperswarm/dht')
const { relay } = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const goodbye = require('graceful-goodbye')
const fastify = require('fastify')
const safetyCatch = require('safety-catch')
const metricsPlugin = require('fastify-metrics')
const websocketPlugin = require('@fastify/websocket')

function setupRelayServer (app, dht, logger, sShutdownMargin) {
  app.register(websocketPlugin, {
    preClose: async function wssPreClose () {
      await closeWsServerConnections(this.websocketServer, logger, sShutdownMargin)
    },
    options: {
      clientTracking: true
    },
    connectionOptions: {
      readableObjectMode: true // See https://github.com/fastify/fastify-websocket/issues/185
    }
  })

  app.register(async function (app) {
    app.get('/', { websocket: true }, (connection, req) => {
      const socket = connection.socket
      const ip = req.socket.remoteAddress
      const port = req.socket.remotePort

      const id = `${ip}:${port}`
      socket.on('error', (error) => {
        // Socket errors are often unexpected hang-ups etc, so we swallow them
        logger.info(`Socket error for connection at ${id} (${error.message})`)
      })

      socket.on('close', () => {
        logger.info(`Stopped relaying to ${id}`)
      })

      logger.info(`Relaying to ${id}`)
      relay(dht, new Stream(false, socket))

      socket.send('You are being relayed')
    })
  })

  logger.info('Setup ws route')
}

function setupHealthEndpoint (app) {
  app.get('/health', { logLevel: 'warn' }, function (req, reply) {
    reply.status(200)
    reply.send('Healthy')
  })
}

async function closeWsServerConnections (wsServer, logger, sShutdownMargin) {
  logger.info('Closing websocket server connections')
  try {
    const closeProm = new Promise(resolve => wsServer.close(resolve))
    closeProm.catch(safetyCatch)

    if (wsServer.clients.size > 0 && sShutdownMargin) {
      logger.info(`Waiting to send close signals to existing clients for ${sShutdownMargin}s (shutdown margin)`)

      for (const socket of wsServer.clients) {
        socket.send(`Server closing. Socket will shut down in ${sShutdownMargin}s`)
      }
    }

    await Promise.race([
      new Promise(resolve => setTimeout(resolve, sShutdownMargin * 1000)),
      closeProm // If all connections close before the timeout
    ])

    const nrRemainingClients = wsServer.clients.size
    if (nrRemainingClients) {
      logger.info(`force-closing connection to ${nrRemainingClients} clients`)

      const goingAwayCode = 1001
      for (const socket of wsServer.clients) {
        socket.close(goingAwayCode, 'Server is going offline')
      }
    }
  } catch (e) {
    logger.error(e)
  }
  logger.info('Closed websocket server connections')
}

async function setup (logger, { wsPort, dhtPort, dhtHost, host, sShutdownMargin } = {}) {
  logger.info('Starting program')

  const dht = new DHT({ port: dhtPort, host: dhtHost })
  const app = fastify({ logger })

  setupRelayServer(app, dht, logger, sShutdownMargin)
  await app.register(metricsPlugin, {
    endpoint: '/metrics',
    routeMetrics: {
      routeBlacklist: ['/health', '/metrics']
    }
  })
  setupHealthEndpoint(app, logger)

  await app.listen({
    port: wsPort,
    host
  })

  goodbye(async () => {
    logger.info('Closing down DHT')
    try {
      await dht.destroy()
    } catch (e) {
      logger.error(e)
    }

    logger.info('Closed down DHT')

    logger.info('Closing down the overall server')
    try {
      await app.close()
    } catch (e) {
      console.error('error while shutting down overall server:', e)
    }
    logger.info('Closed down the overall server')

    logger.info('Exiting program')
  })

  await dht.ready()
  logger.info(`DHT: ${dht.host}:${dht.port} (firewalled: ${dht.firewalled})`)
}

module.exports = setup
