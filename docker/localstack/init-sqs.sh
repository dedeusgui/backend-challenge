#!/bin/sh
set -eu

# LocalStack runs executable scripts in /etc/localstack/init/ready.d.
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes FifoQueue=true
MAIN_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)

# Pass nested JSON as a file instead of relying on CLI shorthand quoting.
cat > /tmp/wager-redrive-policy.json <<EOF
{"RedrivePolicy":"{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"}
EOF
awslocal sqs set-queue-attributes --queue-url "$MAIN_URL" --attributes file:///tmp/wager-redrive-policy.json

awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true
