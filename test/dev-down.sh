#!/usr/bin/env bash
LOG=${LOG:-/tmp/mailforge-logs}; [ -f $LOG/pids ] && xargs kill < $LOG/pids 2>/dev/null; rm -f $LOG/pids; echo stopped
