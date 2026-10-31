# Basic hand-written differential program.
    ori $t0, $zero, 5
    ori $t1, $zero, 7
    add $t2, $t0, $t1
    sw  $t2, 256($zero)
