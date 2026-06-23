// Azure Container Apps deployment for the fitcoach agent (scale to zero, webhook mode).
//
// This is one optional deploy target alongside local Docker and the Cloud Run
// example. It provisions:
//   - a Log Analytics workspace and a Container Apps managed environment,
//   - a storage account and Azure Files share mounted at /data for durable
//     sessions and schedule (so they survive cold starts and restarts),
//   - the agent Container App with external ingress for the Telegram webhook,
//     scaling to zero replicas when idle,
//   - two scheduled Container Apps Jobs that call /cron/run for the seeded
//     reminders (the in-process cron does not run at zero replicas).
//
// The container image must already be pushed to a registry the environment can
// pull from. Pass its reference as containerImage.

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Base name used to derive resource names.')
param name string = 'fitcoach'

@description('Container image reference, e.g. myregistry.azurecr.io/fitcoach-agent:latest')
param containerImage string

@description('Comma-separated numeric Telegram user ids allowed to use the bot.')
param allowedTelegramIds string

@description('Chat id reminders are sent to (usually your own Telegram id).')
param ownerChatId string

@description('Timezone for reminder wording shown to the user.')
param timezone string = 'Europe/London'

@description('What the coach calls itself.')
param agentName string = 'Coach'

@secure()
@description('Claude subscription token from `claude setup-token`.')
param claudeOauthToken string

@secure()
@description('Telegram bot token from @BotFather.')
param telegramBotToken string

@secure()
@description('Notion internal integration token. Leave empty to run without Notion.')
param notionToken string = ''

@secure()
@description('Shared secret the scheduled jobs present to call /cron/run.')
param cronSecret string

var storageAccountName = toLower('${name}st${uniqueString(resourceGroup().id)}')
var shareName = 'data'
var envStorageName = 'data'
var appName = '${name}-agent'

// Deterministic public URL so the app can register its own Telegram webhook and
// the jobs can reach it, without a second deploy pass.
var publicBaseUrl = 'https://${appName}.${managedEnvironment.properties.defaultDomain}'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: 1
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: managedEnvironment
  name: envStorageName
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: shareName
      accessMode: 'ReadWrite'
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      secrets: [
        { name: 'claude-oauth-token', value: claudeOauthToken }
        { name: 'telegram-bot-token', value: telegramBotToken }
        { name: 'notion-token', value: notionToken }
        { name: 'cron-secret', value: cronSecret }
      ]
    }
    template: {
      containers: [
        {
          name: 'agent'
          image: containerImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            { name: 'MODE', value: 'webhook' }
            { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
            { name: 'PORT', value: '8080' }
            { name: 'HOME', value: '/data' }
            { name: 'SESSION_FILE', value: '/data/sessions.json' }
            { name: 'SCHEDULE_FILE', value: '/data/schedule.json' }
            { name: 'AGENT_NAME', value: agentName }
            { name: 'TIMEZONE', value: timezone }
            { name: 'ALLOWED_TELEGRAM_IDS', value: allowedTelegramIds }
            { name: 'OWNER_CHAT_ID', value: ownerChatId }
            { name: 'CLAUDE_CODE_OAUTH_TOKEN', secretRef: 'claude-oauth-token' }
            { name: 'TELEGRAM_BOT_TOKEN', secretRef: 'telegram-bot-token' }
            { name: 'NOTION_TOKEN', secretRef: 'notion-token' }
            { name: 'CRON_SECRET', secretRef: 'cron-secret' }
          ]
          volumeMounts: [
            { volumeName: 'data', mountPath: '/data' }
          ]
        }
      ]
      // Scale to zero when idle; cap at one replica so a single instance owns the
      // mounted file share. An inbound webhook request wakes a replica.
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '10' } }
          }
        ]
      }
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: envStorage.name
        }
      ]
    }
  }
}

// One scheduled job per reminder. Container Apps Jobs interpret the cron in UTC,
// so adjust the hour for your timezone (the example below is 08:00 and 18:00 UTC).
var reminders = [
  { name: 'morning-nudge', cron: '0 8 * * *', taskId: 'morning-nudge' }
  { name: 'weekly-plan', cron: '0 18 * * 0', taskId: 'weekly-plan' }
]

resource reminderJobs 'Microsoft.App/jobs@2024-03-01' = [
  for r in reminders: {
    name: '${name}-${r.name}'
    location: location
    properties: {
      environmentId: managedEnvironment.id
      configuration: {
        triggerType: 'Schedule'
        replicaTimeout: 300
        scheduleTriggerConfig: {
          cronExpression: r.cron
          parallelism: 1
          replicaCompletionCount: 1
        }
        secrets: [
          { name: 'cron-secret', value: cronSecret }
        ]
      }
      template: {
        containers: [
          {
            name: 'trigger'
            image: 'curlimages/curl:8.10.1'
            resources: {
              cpu: json('0.25')
              memory: '0.5Gi'
            }
            env: [
              { name: 'TARGET_URL', value: publicBaseUrl }
              { name: 'TASK_ID', value: r.taskId }
              { name: 'CRON_SECRET', secretRef: 'cron-secret' }
            ]
            command: [
              'sh'
              '-c'
              'curl -fsS -X POST "$TARGET_URL/cron/run" -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" -d "{\\"taskId\\":\\"$TASK_ID\\"}"'
            ]
          }
        ]
      }
    }
  }
]

@description('Public URL of the agent. The Telegram webhook registers at <url>/webhook/telegram.')
output publicUrl string = publicBaseUrl
