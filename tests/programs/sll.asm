# SLL is intentionally sensitive to a shamt wiring fault.
    ori $t0, $zero, 0x1234
    sll $t0, $t0, 16
    ori $t0, $t0, 0x5678
    sll $t1, $t0, 15
    sw  $t1, 256($zero)
