import * as core from '@actions/core'
import * as aws from 'aws-sdk'
import axios, { AxiosResponse } from 'axios'
import { CreateChangeSetInput, CreateStackInput } from './main'

export type Stack = aws.CloudFormation.Stack

interface UrlShortenerResponse {
  link: string
  long_url: string
}

export async function genCfnUrl(
  stackArn: string,
  changeSetArn: string
): Promise<string> {
  const pieces = [
    'https://console.aws.amazon.com/cloudformation/home',
    `?region=${aws.config.region}#/stacks/changesets/changes`,
    `?stackId=${encodeURIComponent(stackArn)}`,
    `&changeSetId=${encodeURIComponent(changeSetArn)}`
  ]

  const url = pieces.join('')

  const short: AxiosResponse<UrlShortenerResponse> = await axios.post(
    'https://api-ssl.bitly.com/v4/shorten',
    {
      long_url: url,
      domain: 'bit.ly'
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.BITLY_TOKEN}`
      }
    }
  )

  return short.data.link
}

export async function cleanupChangeSet(
  cfn: aws.CloudFormation,
  stack: Stack,
  params: CreateChangeSetInput,
  noEmptyChangeSet: boolean,
  noDeleteFailedChangeSet: boolean
): Promise<string | undefined> {
  const knownErrorMessages = [
    `No updates are to be performed`,
    `The submitted information didn't contain changes`
  ]

  const changeSetStatus = await cfn
    .describeChangeSet({
      ChangeSetName: params.ChangeSetName,
      StackName: params.StackName
    })
    .promise()

  if (changeSetStatus.Status === 'FAILED') {
    core.debug('Deleting failed Change Set')

    if (!noDeleteFailedChangeSet) {
      await cfn
        .deleteChangeSet({
          ChangeSetName: params.ChangeSetName,
          StackName: params.StackName
        })
        .promise()
    }

    if (
      noEmptyChangeSet &&
      knownErrorMessages.some(err =>
        changeSetStatus.StatusReason?.includes(err)
      )
    ) {
      return stack.StackId
    }

    throw new Error(
      `Failed to create Change Set: ${changeSetStatus.StatusReason}`
    )
  }
}

export async function updateStack(
  cfn: aws.CloudFormation,
  stack: Stack,
  params: CreateChangeSetInput,
  noEmptyChangeSet: boolean,
  noExecuteChageSet: boolean,
  noDeleteFailedChangeSet: boolean
): Promise<string | undefined> {
  core.info('Creating CloudFormation Change Set')
  const cset = await cfn.createChangeSet(params).promise()

  try {
    core.info('Waiting for CloudFormation Change Set creation')
    await cfn
      .waitFor('changeSetCreateComplete', {
        ChangeSetName: params.ChangeSetName,
        StackName: params.StackName
      })
      .promise()
  } catch (e) {
    core.info(e)

    return cleanupChangeSet(
      cfn,
      stack,
      params,
      noEmptyChangeSet,
      noDeleteFailedChangeSet
    )
  }

  if (noExecuteChageSet) {
    core.info('Changeset created')
    core.info(await genCfnUrl(stack.StackId!, cset.Id!))

    core.debug('Not executing the change set')
    return stack.StackId
  }

  core.debug('Executing CloudFormation change set')
  await cfn
    .executeChangeSet({
      ChangeSetName: params.ChangeSetName,
      StackName: params.StackName
    })
    .promise()

  core.debug('Updating CloudFormation stack')
  await cfn
    .waitFor('stackUpdateComplete', { StackName: stack.StackId })
    .promise()

  return stack.StackId
}

async function getStack(
  cfn: aws.CloudFormation,
  stackNameOrId: string
): Promise<Stack | undefined> {
  try {
    const stacks = await cfn
      .describeStacks({
        StackName: stackNameOrId
      })
      .promise()
    return stacks.Stacks?.[0]
  } catch (e) {
    if (e.code === 'ValidationError' && e.message.match(/does not exist/)) {
      return undefined
    }
    throw e
  }
}

export async function deployStack(
  cfn: aws.CloudFormation,
  params: CreateStackInput,
  noEmptyChangeSet: boolean,
  noExecuteChageSet: boolean,
  noDeleteFailedChangeSet: boolean
): Promise<string | undefined> {
  const stack = await getStack(cfn, params.StackName)

  if (!stack) {
    core.debug(`Creating CloudFormation Stack`)

    const stack = await cfn.createStack(params).promise()
    await cfn
      .waitFor('stackCreateComplete', { StackName: params.StackName })
      .promise()

    return stack.StackId
  }

  return await updateStack(
    cfn,
    stack,
    {
      ChangeSetName: `${params.StackName}-CS`,
      ...{
        StackName: params.StackName,
        TemplateBody: params.TemplateBody,
        Parameters: params.Parameters,
        Capabilities: params.Capabilities,
        ResourceTypes: params.ResourceTypes,
        RoleARN: params.RoleARN,
        RollbackConfiguration: params.RollbackConfiguration,
        NotificationARNs: params.NotificationARNs,
        Tags: params.Tags
      }
    },
    noEmptyChangeSet,
    noExecuteChageSet,
    noDeleteFailedChangeSet
  )
}

export async function getStackOutputs(
  cfn: aws.CloudFormation,
  stackId: string
): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  const stack = await getStack(cfn, stackId)

  if (stack && stack.Outputs) {
    for (const output of stack.Outputs) {
      if (output.OutputKey && output.OutputValue) {
        outputs.set(output.OutputKey, output.OutputValue)
      }
    }
  }

  return outputs
}
