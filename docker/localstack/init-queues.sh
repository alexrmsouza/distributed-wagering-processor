#!/bin/sh

set -eu

COMMAND_QUEUE_NAME="wager-transactions.fifo"
COMMAND_DLQ_NAME="wager-transactions-dlq.fifo"
EVENT_QUEUE_NAME="wager-integration-events.fifo"

create_fifo_queue() {
  queue_name="$1"
  attributes="$2"

  if queue_url="$(awslocal sqs get-queue-url --queue-name "$queue_name" --query QueueUrl --output text 2>/dev/null)"; then
    printf '%s\n' "$queue_url"
    return
  fi

  awslocal sqs create-queue \
    --queue-name "$queue_name" \
    --attributes "$attributes" \
    --query QueueUrl \
    --output text
}

command_dlq_url="$(
  create_fifo_queue \
    "$COMMAND_DLQ_NAME" \
    "FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600"
)"

command_dlq_arn="$(
  awslocal sqs get-queue-attributes \
    --queue-url "$command_dlq_url" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' \
    --output text
)"

command_queue_url="$(
  create_fifo_queue \
    "$COMMAND_QUEUE_NAME" \
    "FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30,ReceiveMessageWaitTimeSeconds=20"
)"

command_queue_attributes="$(
  printf \
    '{"VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' \
    "$command_dlq_arn"
)"

awslocal sqs set-queue-attributes \
  --queue-url "$command_queue_url" \
  --attributes "$command_queue_attributes"

create_fifo_queue \
  "$EVENT_QUEUE_NAME" \
  "FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30,ReceiveMessageWaitTimeSeconds=20" \
  >/dev/null

printf '%s\n' "LocalStack FIFO queues are ready."
