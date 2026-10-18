package com.usegarret.app

// Run on the JVM; no Android activity or provider is needed.
fun main() {
    val lifecycle = TransferLifecycle<Any>()
    check(lifecycle.admissionCode() == "transfer_stale")
    val first = Any()
    val replacement = Any()
    lifecycle.attach(first)
    check(lifecycle.admissionCode() == null)
    check(lifecycle.detach(first))
    check(lifecycle.admissionCode() == "transfer_stale")
    lifecycle.attach(replacement)
    check(!lifecycle.detach(first))
    check(lifecycle.owner === replacement)
    check(lifecycle.admissionCode() == null)
    lifecycle.requireRestart()
    check(lifecycle.detach(replacement))
    lifecycle.attach(Any())
    check(lifecycle.admissionCode() == "transfer_restart")
    println("Activity replacement restores admission; blocked close remains terminal")
}
