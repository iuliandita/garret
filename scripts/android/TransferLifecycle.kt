package com.usegarret.app

// Activity loss is recoverable. A blocked provider close is process-wide and terminal.
internal class TransferLifecycle<A> {
    var owner: A? = null
        private set
    var restartRequired = false
        private set

    fun attach(activity: A) { owner = activity }
    fun detach(activity: A): Boolean {
        if (owner !== activity) return false
        owner = null
        return true
    }
    fun requireRestart() { restartRequired = true }
    fun admissionCode(): String? = when {
        restartRequired -> "transfer_restart"
        owner == null -> "transfer_stale"
        else -> null
    }
}
